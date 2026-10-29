/*
 * Copyright 2026 The Stepstone Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  HttpAuthService,
  PermissionsService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import { InputError, NotFoundError, NotAllowedError } from '@backstage/errors';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import express from 'express';
import Router from 'express-promise-router';
import {
  OwnershipStore,
  EntityFilter,
  ScanFilter,
} from './service/DatabaseOwnershipStore';
import { ProposalLifecycleService } from './service/ProposalLifecycleService';
import { OwnershipMatcherService } from './service/OwnershipMatcherService';
import {
  CatalogService,
  compileConfigRegex,
  testConfigRegex,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { EscalationConfig } from './config/types';
import { OwnershipEntityRow, ProposalStatus, toOwnershipEntity } from './types';
import { OwnershipCheck } from './checks/types';
import { ProposalStrategy, SignalDefinition } from './proposals/types';
import {
  createEscalationRouter,
  proposalRejectSchema,
  type EscalationService,
  type EscalationTrigger,
} from './escalation';
import { OwnershipEmailTask } from './service/notifications/OwnershipEmailTask';
import type { PrCreationService } from './pr';
import { createAdminAuth } from './adminAuth';

/** Valid query-string proposal statuses for the `for-team` endpoint. */
const VALID_STATUSES: readonly ProposalStatus[] = [
  'pending',
  'accepted',
  'rejected',
  'expired',
  'possible_owner',
];

/** Body schema for `POST /proposals/:id/accept`. */
const acceptSchema = z.object({}).strict();

/** Maximum page size for any paginated list endpoint. */
const MAX_PAGE_LIMIT = 200;

/** Maximum items accepted in a comma-separated query parameter. */
const MAX_QUERY_LIST_ITEMS = 50;

/** Maximum raw length (chars) of a comma-separated query string before parsing. */
const MAX_QUERY_LIST_INPUT_CHARS = 1000;

/** Hard cap on per-request enrichment fan-out for `/proposals/for-team`. */
const MAX_PROPOSALS_PER_TEAM_QUERY = 500;

/**
 * Parse a comma-separated query parameter into a trimmed string array, with
 * explicit bounds on both the raw input length and the resulting item count.
 * Throws {@link InputError} when either limit is exceeded.
 */
function parseCommaList(
  raw: unknown,
  opts: { maxItems?: number } = {},
): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  const str = Array.isArray(raw) ? raw.join(',') : String(raw);
  if (str.length > MAX_QUERY_LIST_INPUT_CHARS) {
    throw new InputError(
      `Query list value too long (max ${MAX_QUERY_LIST_INPUT_CHARS} chars)`,
    );
  }
  const items = str
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const max = opts.maxItems ?? MAX_QUERY_LIST_ITEMS;
  if (items.length > max) {
    throw new InputError(`Too many items in query list (max ${max} allowed)`);
  }
  return items;
}

const STATIC_SIGNAL_DEFINITIONS: SignalDefinition[] = [
  {
    key: 'escalation',
    title: 'Escalation',
    description: 'This proposal was created through the escalation process.',
  },
];

export async function createRouter({
  httpAuth,
  userInfo,
  permissions,
  store,
  lifecycleService,
  scanService,
  catalogService,
  escalationConfig,
  escalationService,
  escalationTrigger,
  prCreationService,
  checks,
  strategies,
  ownershipEmailTask,
}: {
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
  permissions?: PermissionsService;
  store: OwnershipStore;
  lifecycleService: ProposalLifecycleService;
  scanService: OwnershipMatcherService;
  catalogService: CatalogService;
  /** Validated `EscalationConfig` from `readEscalationConfig`. */
  escalationConfig?: EscalationConfig;
  /** Pairs with `escalationConfig`. */
  escalationService?: EscalationService;
  /** Boundary used by `POST /proposals/:id/reject` to escalate when the rejected proposal was the last candidate. */
  escalationTrigger: EscalationTrigger;
  /** When provided (PR automation enabled), mounts `POST /entities/:id/pr/retry`. */
  prCreationService?: Pick<PrCreationService, 'requestRetry'>;
  checks: OwnershipCheck[];
  strategies: ProposalStrategy[];
  /** When provided, enables the POST /email-digest/trigger admin endpoint. */
  ownershipEmailTask?: OwnershipEmailTask;
}): Promise<express.Router> {
  const router = Router();
  router.use(express.json());

  // ── Escalation actions API ────────────────────────────────
  // Both `escalationConfig` and `escalationService` are required to mount.
  // `readEscalationConfig` returning `undefined` is the canonical
  // disable signal — that disables both flags here.
  if (escalationService && escalationConfig) {
    const escalationRouter = await createEscalationRouter({
      httpAuth,
      permissions,
      store,
      escalationService,
      scannerService: scanService,
      catalogService,
      config: escalationConfig,
    });
    router.use(escalationRouter);
  }

  /** Verify the acting user is a member of the proposal's target group. */
  async function assertUserIsTeamMember(
    userRef: string,
    groupRef: string,
  ): Promise<void> {
    const isMember = await catalogService.isUserMemberOfGroup(
      userRef,
      groupRef,
    );
    if (!isMember) {
      throw new NotAllowedError(
        `User ${userRef} is not a member of ${groupRef}`,
      );
    }
  }

  const { isAdmin, assertAdmin } = createAdminAuth({ httpAuth, permissions });

  // ── Stats ──────────────────────────────────────────────────────────────────

  /** GET /stats Admin-only. Returns aggregate counts for the admin dashboard: totalOpen, perCheck (per check-name counts), pendingProposals, totalProposals, avgConfidence */
  router.get('/stats', async (req, res) => {
    await assertAdmin(req);
    res.json(await store.getDashboardStats());
  });

  // ── Definitions ────────────────────────────────────────────────────────────

  /** GET /definitions Returns human-readable titles and descriptions for all registered check types and signal keys, so frontends don't need to hardcode them. */
  router.get('/definitions', (_req, res) => {
    res.json({
      checks: checks.map(c => ({
        key: c.name,
        title: c.title,
        description: c.description,
      })),
      signals: [
        ...STATIC_SIGNAL_DEFINITIONS,
        ...strategies.flatMap(s => s.signalDefinitions),
      ],
    });
  });

  // ── Entities ───────────────────────────────────────────────────────────────

  /**
   * Throws unless the caller may view this case: admins, the current
   * escalation actor, and members of the assigned team or of any team with a
   * proposal on the entity. Team membership uses `ownershipEntityRefs`
   * (transitive), consistent with `/proposals/for-team`.
   */
  async function assertCanViewEntity(
    req: express.Request,
    entity: OwnershipEntityRow,
    proposals: { proposed_owner_ref: string }[],
  ): Promise<void> {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    if (await isAdmin(credentials)) return;

    const userRef = credentials.principal.userEntityRef;
    const activeEntry = await store.findActiveQueueEntry(entity.id);
    if (activeEntry?.resolved_actor_ref === userRef) return;

    const { ownershipEntityRefs } = await userInfo.getUserInfo(credentials);
    const callerRefs = new Set(
      ownershipEntityRefs.map(r => r.toLocaleLowerCase('en-US')),
    );
    const involvedTeams = [
      entity.assigned_to,
      ...proposals.map(p => p.proposed_owner_ref),
    ];
    if (
      involvedTeams.some(
        ref => ref && callerRefs.has(ref.toLocaleLowerCase('en-US')),
      )
    ) {
      return;
    }
    throw new NotAllowedError(
      `User ${userRef} is not involved in ownership case ${entity.id}`,
    );
  }

  /** GET /entities Admin-only. Query params: status, kind, namespace, check, page, limit */
  router.get('/entities', async (req, res) => {
    await assertAdmin(req);
    const { status, kind, namespace, check, assignedTo, page, limit } =
      req.query;

    const filter: EntityFilter = {};
    if (status) {
      filter.status = (Array.isArray(status) ? status : [status]) as any;
    }
    if (kind) filter.kind = String(kind);
    if (namespace) filter.namespace = String(namespace);
    if (check) filter.check = String(check);
    if (assignedTo) filter.assignedTo = String(assignedTo);

    const result = await store.listEntities(filter, {
      page: page ? Number(page) : 1,
      limit: limit ? Math.min(Number(limit), MAX_PAGE_LIMIT) : 50,
    });

    const boundedItems = result.items.slice(0, MAX_PAGE_LIMIT);
    res.json({ ...result, items: boundedItems.map(toOwnershipEntity) });
  });

  /** GET /entities/:id Returns entity detail with proposals and history. Admins and involved users only. */
  router.get('/entities/:id', async (req, res) => {
    const entity = await store.getEntityById(req.params.id);
    if (!entity) throw new NotFoundError(`Entity ${req.params.id} not found`);

    const proposals = await store.listProposalsByEntity(entity.id);
    await assertCanViewEntity(req, entity, proposals);
    const history = await store.listHistory(entity.id);

    res.json({ entity: toOwnershipEntity(entity), proposals, history });
  });

  /**
   * POST /entities/:id/pr/retry Re-enqueue a failed, declined or
   * unsupported_scm catalog-info PR.
   * Allowed for admins and members of the accepted owner team.
   */
  router.post('/entities/:id/pr/retry', async (req, res) => {
    if (!prCreationService) {
      throw new NotFoundError('PR automation is disabled');
    }
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const actorRef = credentials.principal.userEntityRef;

    const entity = await store.getEntityById(req.params.id);
    if (!entity) throw new NotFoundError(`Entity ${req.params.id} not found`);
    if (!(await isAdmin(credentials))) {
      if (!entity.assigned_to) {
        throw new NotAllowedError('Entity has no accepted owner team');
      }
      await assertUserIsTeamMember(actorRef, entity.assigned_to);
    }

    const updated = await prCreationService.requestRetry(entity.id, actorRef);
    res.status(202).json({ entity: toOwnershipEntity(updated) });
  });

  // ── Proposals ──────────────────────────────────────────────────────────────

  /** GET /proposals Admin-scoped paginated list of all proposals across all entities, enriched with entity context and the actor who responded. */
  router.get('/proposals', async (req, res) => {
    await assertAdmin(req);
    const statuses = parseCommaList(req.query.status, {
      maxItems: VALID_STATUSES.length,
    });

    if (statuses.length > 0) {
      const invalid = statuses.find(
        s => !(VALID_STATUSES as readonly string[]).includes(s),
      );
      if (invalid) {
        throw new InputError(
          `Invalid status value: "${invalid}". Allowed: ${VALID_STATUSES.join(
            ', ',
          )}`,
        );
      }
    }

    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit
      ? Math.min(Number(req.query.limit), MAX_PAGE_LIMIT)
      : 50;

    const rawSearch = req.query.search ? String(req.query.search).trim() : '';
    if (rawSearch.length > 200) {
      throw new InputError('search query is too long (max 200 chars)');
    }
    const search = rawSearch || undefined;

    const filter: { status?: ProposalStatus[]; search?: string } = {};
    if (statuses.length > 0) filter.status = statuses as ProposalStatus[];
    if (search) filter.search = search;

    const result = await store.listAllProposals(
      { page, limit },
      Object.keys(filter).length > 0 ? filter : undefined,
    );

    // Enrich with entity + actor — same pattern as /proposals/for-team.
    const entityCache = new Map<string, OwnershipEntityRow>();
    const boundedProposals = result.items.slice(0, MAX_PAGE_LIMIT);
    const items = await Promise.all(
      boundedProposals.map(async proposal => {
        let entity = entityCache.get(proposal.entity_id);
        if (!entity) {
          const fetched = await store.getEntityById(proposal.entity_id);
          if (fetched) {
            entityCache.set(proposal.entity_id, fetched);
            entity = fetched;
          }
        }
        if (!entity) return null;

        let actor: string | null = null;
        if (proposal.status === 'accepted' || proposal.status === 'rejected') {
          const history = await store.listHistory(proposal.entity_id);
          const entry = history.find(
            h =>
              h.proposal_id === proposal.id &&
              (h.action === 'proposal_accepted' ||
                h.action === 'proposal_rejected'),
          );
          actor = entry?.actor ?? null;
        }

        return { proposal, entity, actor };
      }),
    );

    res.json({
      items: items.slice(0, MAX_PAGE_LIMIT).filter(Boolean),
      total: result.total,
      page: result.page,
      limit: result.limit,
    });
  });

  /**
   * GET /proposals/mine/summary
   *
   * Authenticated count of pending proposals addressed to any group the
   * caller belongs to. Returns a content-hash so dismissals stay sticky
   * until the underlying set of pending proposals changes.
   */
  router.get('/proposals/mine/summary', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { ownershipEntityRefs } = await userInfo.getUserInfo(credentials);

    const groupRefs = ownershipEntityRefs.filter(r => r.startsWith('group:'));
    if (groupRefs.length === 0) {
      res.json({ pendingCount: 0, link: '/my-ownership-proposals', hash: '' });
      return;
    }

    const allIds = new Set<string>();
    const perGroupIds = await Promise.all(
      groupRefs.map(ref => store.listPendingProposalIdsForOwner(ref)),
    );
    for (const ids of perGroupIds) {
      for (const id of ids) allIds.add(id);
    }

    if (allIds.size === 0) {
      res.json({ pendingCount: 0, link: '/my-ownership-proposals', hash: '' });
      return;
    }

    const hash = createHash('sha1')
      .update(
        Array.from(allIds)
          .sort((a, b) => a.localeCompare(b))
          .join(','),
      )
      .digest('hex')
      .slice(0, 12);

    res.json({
      pendingCount: allIds.size,
      link: '/my-ownership-proposals',
      hash,
    });
  });

  /** GET /proposals/for-team Returns proposals addressed to the given team(s) with entity context and the actor who responded (for accepted/rejected proposals). */
  router.get('/proposals/for-team', async (req, res) => {
    const requestedTeamRefs = parseCommaList(req.query.teamRef, {
      maxItems: 50,
    });
    if (requestedTeamRefs.length === 0) {
      throw new InputError('At least one teamRef query parameter is required');
    }

    // Non-admins only see their own teams' proposals. Checked against
    // `ownershipEntityRefs` (transitive, the same refs the UI sends) rather
    // than `isUserMemberOfGroup` (direct `memberOf` only), so users in nested
    // teams keep their parent groups. Foreign refs are dropped, not rejected.
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    let teamRefs = requestedTeamRefs;
    if (!(await isAdmin(credentials))) {
      const { ownershipEntityRefs } = await userInfo.getUserInfo(credentials);
      const callerRefs = new Set(
        ownershipEntityRefs.map(r => r.toLocaleLowerCase('en-US')),
      );
      teamRefs = requestedTeamRefs.filter(r =>
        callerRefs.has(r.toLocaleLowerCase('en-US')),
      );
      if (teamRefs.length === 0) {
        res.json({ items: [] });
        return;
      }
    }

    const statuses = parseCommaList(req.query.status ?? 'pending', {
      maxItems: VALID_STATUSES.length,
    });
    const invalidStatus = statuses.find(
      s => !(VALID_STATUSES as readonly string[]).includes(s),
    );
    if (invalidStatus) {
      throw new InputError(
        `Invalid status value: "${invalidStatus}". Allowed: ${VALID_STATUSES.join(
          ', ',
        )}`,
      );
    }

    const proposals = await store.listProposalsForOwners(
      teamRefs,
      statuses as ProposalStatus[],
    );

    // Enrich each proposal with its entity. For already-responded proposals
    // (accepted/rejected) we also surface the actor from the history log so
    // the user-facing history tab can show "who on your team responded".
    // Entity results are cached within this request to avoid redundant queries
    // when multiple proposals point to the same entity.
    const entityCache = new Map<string, OwnershipEntityRow>();

    const boundedProposals = proposals.slice(0, MAX_PROPOSALS_PER_TEAM_QUERY);
    const items = await Promise.all(
      boundedProposals.map(async proposal => {
        let entity = entityCache.get(proposal.entity_id);
        if (!entity) {
          const fetched = await store.getEntityById(proposal.entity_id);
          if (fetched) {
            entityCache.set(proposal.entity_id, fetched);
            entity = fetched;
          }
        }
        if (!entity) return null;

        let actor: string | null = null;
        if (proposal.status === 'accepted' || proposal.status === 'rejected') {
          const history = await store.listHistory(proposal.entity_id);
          const entry = history.find(
            h =>
              h.proposal_id === proposal.id &&
              (h.action === 'proposal_accepted' ||
                h.action === 'proposal_rejected'),
          );
          actor = entry?.actor ?? null;
        }

        return { proposal, entity: toOwnershipEntity(entity), actor };
      }),
    );

    res.json({
      items: items.slice(0, MAX_PROPOSALS_PER_TEAM_QUERY).filter(Boolean),
    });
  });

  /** GET /entities/:id/proposals Admins and involved users only. */
  router.get('/entities/:id/proposals', async (req, res) => {
    const entity = await store.getEntityById(req.params.id);
    if (!entity) throw new NotFoundError(`Entity ${req.params.id} not found`);

    const proposals = await store.listProposalsByEntity(entity.id);
    await assertCanViewEntity(req, entity, proposals);
    res.json({ proposals });
  });

  /** POST /proposals/:id/accept Authenticated — requires a user credential. */
  router.post('/proposals/:id/accept', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const actorRef = credentials.principal.userEntityRef;

    const proposal = await store.getProposal(req.params.id);
    if (!proposal)
      throw new NotFoundError(`Proposal ${req.params.id} not found`);
    if (!(await isAdmin(credentials))) {
      await assertUserIsTeamMember(actorRef, proposal.proposed_owner_ref);
    }

    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());

    const result = await lifecycleService.acceptProposal(
      req.params.id,
      actorRef,
    );
    res.status(200).json({
      status: 'accepted',
      proposal: result.proposal,
      entity: toOwnershipEntity(result.entity),
    });
  });

  /** POST /proposals/:id/reject Body: { reason: string } — mandatory `.min(1)`. */
  router.post('/proposals/:id/reject', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const actorRef = credentials.principal.userEntityRef;

    const proposal = await store.getProposal(req.params.id);
    if (!proposal)
      throw new NotFoundError(`Proposal ${req.params.id} not found`);
    if (!(await isAdmin(credentials))) {
      await assertUserIsTeamMember(actorRef, proposal.proposed_owner_ref);
    }

    const parsed = proposalRejectSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());

    const result = await lifecycleService.rejectProposal(
      req.params.id,
      actorRef,
      parsed.data.reason,
    );

    // Escalate only when the rejection exhausted the candidate list. The
    // trigger is idempotent for already-`escalated` entities, but the cheap
    // pre-check here keeps history clean for the common case where there's
    // still a pending proposal.
    const remaining = await store.listActiveProposalsByEntity(result.entity.id);
    if (remaining.length === 0) {
      await escalationTrigger.triggerEscalation(result.entity.id);
    }

    // Re-fetch after the trigger so the response reflects post-trigger state
    // (status may have flipped open → escalated/unresolved). Fall back to the
    // pre-trigger snapshot defensively if the row vanished.
    const refreshed = await store.getEntityById(result.entity.id);
    res.status(200).json({
      status: 'rejected',
      proposal: result.proposal,
      entity: toOwnershipEntity(refreshed ?? result.entity),
    });
  });

  // ── Leadership ─────────────────────────────────────────────────────────────

  /**
   * Resolves the group refs in the authenticated user's managed subtree.
   *
   * A user leads a group when their job title matches any `titlePatterns`
   * in the escalation config. Their managed area is those root groups plus
   * all descendants (walkGroupHierarchy 'down').
   *
   * When no escalation config / title patterns are configured, falls back to
   * the user's direct group memberships with no subtree expansion.
   *
   * A user who currently holds an active escalation is also a leader (no
   * subtree expansion), so they can reach the cases routed to them.
   */
  async function resolveManagedGroupRefs(req: express.Request): Promise<{
    groupRefs: string[];
    isLeader: boolean;
    userEntityRef: string;
    assignedEscalations: number;
  }> {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { userEntityRef: tokenUserRef } = await userInfo.getUserInfo(
      credentials,
    );

    const asUserParam =
      process.env.NODE_ENV !== 'production'
        ? (req.query.asUser as string | undefined)
        : undefined;
    const userEntityRef = asUserParam ?? tokenUserRef;

    // Escalations are routed along the AD manager chain, not the catalog group
    // hierarchy, so whoever currently holds an active escalation counts as a
    // leader regardless of their own groups or title.
    const assignedEscalations = await store.countActiveEscalationsForActor(
      userEntityRef,
    );
    const base = { userEntityRef, assignedEscalations };
    const isAssignee = assignedEscalations > 0;

    // Resolve the user entity to get direct group memberships (spec.memberOf)
    // and job title. ownershipEntityRefs includes the full transitive parent
    // chain, which is too broad — we want only the groups the user directly
    // belongs to as the candidate roots.
    const userEntity = await catalogService.getEntityByRef(userEntityRef);
    if (!userEntity) return { ...base, groupRefs: [], isLeader: isAssignee };

    const directMemberOf: string[] = (
      (userEntity.spec as any)?.memberOf ?? []
    ).map((ref: string) => (ref.includes(':') ? ref : `group:default/${ref}`));

    if (directMemberOf.length === 0) {
      return { ...base, groupRefs: [], isLeader: isAssignee };
    }

    // Collect all title-pattern regexes from escalation config levels.
    const allPatterns = (escalationConfig?.levels ?? [])
      .flatMap(l => l.titlePatterns ?? [])
      .map(p => compileConfigRegex(p));

    const jobTitle: string | undefined =
      userEntity.metadata.userDetails?.jobTitle ??
      userEntity.spec?.profile?.title;

    const isTitleLeader =
      jobTitle !== undefined &&
      allPatterns.length > 0 &&
      allPatterns.some(re => testConfigRegex(re, jobTitle));

    if (!isTitleLeader) {
      return { ...base, groupRefs: directMemberOf, isLeader: isAssignee };
    }

    // Leader: expand each direct group downward to include all sub-groups.
    const allRefs = new Set<string>(directMemberOf);
    await Promise.all(
      directMemberOf.map(async ref => {
        const children = await catalogService.walkGroupHierarchy(ref, 'down');
        for (const g of children) allRefs.add(g.ref);
      }),
    );

    return { ...base, groupRefs: Array.from(allRefs), isLeader: true };
  }

  /**
   * GET /leadership/stats
   * Returns stats scoped to the authenticated user's managed group subtree.
   */
  router.get('/leadership/stats', async (req, res) => {
    const { groupRefs, isLeader, userEntityRef, assignedEscalations } =
      await resolveManagedGroupRefs(req);
    if (groupRefs.length === 0 && assignedEscalations === 0) {
      res.json({
        isLeader,
        totalOpen: 0,
        perCheck: {},
        pendingProposals: 0,
        totalProposals: 0,
        avgConfidence: null,
      });
      return;
    }

    const [entityStats, pendingProposals, allProposals] = await Promise.all([
      store.getStatsForOwners(groupRefs, userEntityRef),
      store.listProposalsForOwners(groupRefs, ['pending']),
      store.listProposalsForOwners(groupRefs, [
        'pending',
        'accepted',
        'rejected',
        'expired',
      ]),
    ]);

    const scores = allProposals
      .map(p => p.confidence_score)
      .filter((s): s is number => s !== null && s !== undefined);
    const avgConfidence =
      scores.length > 0
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : null;

    res.json({
      isLeader,
      totalOpen: entityStats.totalOpen,
      perCheck: entityStats.perCheck,
      pendingProposals: pendingProposals.length,
      totalProposals: allProposals.length,
      avgConfidence,
    });
  });

  /**
   * GET /leadership/entities
   * Returns paginated entities owned by groups in the user's managed subtree.
   * Escalated entities are instead those whose active escalation is assigned
   * to the user (`escalation_queue_entries.resolved_actor_ref`).
   * Query params: status (csv), kind, page, limit.
   */
  router.get('/leadership/entities', async (req, res) => {
    const { groupRefs, userEntityRef, assignedEscalations } =
      await resolveManagedGroupRefs(req);
    if (groupRefs.length === 0 && assignedEscalations === 0) {
      res.json({ items: [], total: 0, page: 1, limit: 50 });
      return;
    }

    const { status, kind, page, limit } = req.query;
    const pageNum = page ? Number(page) : 1;
    const pageLimit = limit ? Math.min(Number(limit), MAX_PAGE_LIMIT) : 50;

    const filter: EntityFilter = {
      owners: groupRefs,
      escalationActorRef: userEntityRef,
    };
    if (status) {
      filter.status = (Array.isArray(status) ? status : [status]) as any;
    }
    if (kind) filter.kind = String(kind);

    const result = await store.listEntities(filter, {
      page: pageNum,
      limit: pageLimit,
    });
    res.json({ ...result, items: result.items.map(toOwnershipEntity) });
  });

  /**
   * GET /leadership/proposals
   * Returns proposals for all teams in the user's managed group subtree.
   * Query params: status (csv, default: pending), page, limit.
   */
  router.get('/leadership/proposals', async (req, res) => {
    const { groupRefs } = await resolveManagedGroupRefs(req);
    if (groupRefs.length === 0) {
      res.json({ items: [], total: 0, page: 1, limit: 50 });
      return;
    }

    const statuses = parseCommaList(req.query.status ?? 'pending', {
      maxItems: VALID_STATUSES.length,
    });
    const invalidStatus = statuses.find(
      s => !(VALID_STATUSES as readonly string[]).includes(s),
    );
    if (invalidStatus) {
      throw new InputError(
        `Invalid status value: "${invalidStatus}". Allowed: ${VALID_STATUSES.join(
          ', ',
        )}`,
      );
    }

    const page = req.query.page ? Number(req.query.page) : 1;
    const pageLimit = req.query.limit
      ? Math.min(Number(req.query.limit), MAX_PAGE_LIMIT)
      : 50;

    const proposals = await store.listProposalsForOwners(
      groupRefs,
      statuses as ProposalStatus[],
    );

    const total = proposals.length;
    const start = (page - 1) * pageLimit;
    const paged = proposals.slice(start, start + pageLimit);

    const entityCache = new Map<string, OwnershipEntityRow>();
    const items = await Promise.all(
      paged.map(async proposal => {
        let entity = entityCache.get(proposal.entity_id);
        if (!entity) {
          const fetched = await store.getEntityById(proposal.entity_id);
          if (fetched) {
            entityCache.set(proposal.entity_id, fetched);
            entity = fetched;
          }
        }
        if (!entity) return null;

        let actor: string | null = null;
        if (proposal.status === 'accepted' || proposal.status === 'rejected') {
          const history = await store.listHistory(proposal.entity_id);
          const entry = history.find(
            h =>
              h.proposal_id === proposal.id &&
              (h.action === 'proposal_accepted' ||
                h.action === 'proposal_rejected'),
          );
          actor = entry?.actor ?? null;
        }

        return { proposal, entity: toOwnershipEntity(entity), actor };
      }),
    );

    res.json({ items: items.filter(Boolean), total, page, limit: pageLimit });
  });

  // ── Scans ──────────────────────────────────────────────────────────────────

  /** GET /scans Query params: limit (default 20), status, since (ISO date), until (ISO date) */
  router.get('/scans', async (req, res) => {
    await assertAdmin(req);
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 100) : 20;

    const scanFilter: ScanFilter = {};
    if (req.query.status) {
      const s = String(req.query.status);
      if (!['running', 'completed', 'failed'].includes(s)) {
        throw new InputError(`Invalid status filter: ${s}`);
      }
      scanFilter.status = s as ScanFilter['status'];
    }
    if (req.query.since) {
      const d = new Date(String(req.query.since));
      if (Number.isNaN(d.getTime()))
        throw new InputError(`Invalid since date: ${req.query.since}`);
      scanFilter.since = d;
    }
    if (req.query.until) {
      const d = new Date(String(req.query.until));
      if (Number.isNaN(d.getTime()))
        throw new InputError(`Invalid until date: ${req.query.until}`);
      scanFilter.until = d;
    }

    const scans = await store.listScans(limit, scanFilter);
    res.json({ scans });
  });

  /** GET /scans/:id */
  router.get('/scans/:id', async (req, res) => {
    await assertAdmin(req);
    const scan = await store.getScan(req.params.id);
    if (!scan) throw new NotFoundError(`Scan ${req.params.id} not found`);
    res.json({ scan });
  });

  /** POST /scans/trigger Manually trigger a scan. */
  router.post('/scans/trigger', async (req, res) => {
    await assertAdmin(req);
    // Fire and forget — don't await the full scan.
    scanService.runScan().catch(() => {
      // Errors are already logged and persisted inside runScan.
    });
    res.status(202).json({ status: 'scan_triggered' });
  });

  // ── Ownership email digest ──────────────────────────────────────────────────

  /**
   * POST /email-digest/trigger
   * Admin endpoint to manually trigger the ownership email digest run.
   * Respects idempotency — teams that already received an email this period are skipped.
   * Only available when ownershipMatcher.email is configured.
   */
  if (ownershipEmailTask) {
    router.post('/email-digest/trigger', async (req, res) => {
      await assertAdmin(req);
      const result = await ownershipEmailTask.run();
      res.status(200).json({ status: 'completed', ...result });
    });
  }

  return router;
}
