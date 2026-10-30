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
  BackstageCredentials,
  BackstageUserPrincipal,
  HttpAuthService,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import {
  ConflictError,
  InputError,
  NotAllowedError,
  NotFoundError,
  NotImplementedError as BackstageNotImplementedError,
} from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { OwnershipStore } from '../service/DatabaseOwnershipStore';
import { CatalogService } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { EscalationConfig } from '../config/types';
import { EscalationService } from './EscalationService';
import { OwnershipMatcherService } from '../service/OwnershipMatcherService';
import {
  escalationArchiveSchema,
  escalationAssignSchema,
  escalationRejectSchema,
  escalationRetriggerSchema,
  escalationSuggestSchema,
} from './schemas';
import { createAdminAuth } from '../adminAuth';

/** Dependencies for {@link createEscalationRouter}. */
export interface EscalationRouterDeps {
  httpAuth: HttpAuthService;
  /** Used to authorise admins acting on `unresolved` entities (no escalation actor exists). */
  permissions?: PermissionsService;
  /** Read-only access to entities and the new `findActiveQueueEntry` accessor (fix B). */
  store: OwnershipStore;
  escalationService: EscalationService;
  catalogService: CatalogService;
  config: EscalationConfig;
  /** Scanner used by the retrigger handler to perform the re-scan before delegating to `escalationService.escalationRetrigger`. */
  scannerService?: OwnershipMatcherService;
}

/** Builds the Express router for the escalation actions API. */
export async function createEscalationRouter(
  deps: EscalationRouterDeps,
): Promise<express.Router> {
  const {
    httpAuth,
    permissions,
    store,
    escalationService,
    catalogService,
    config,
    scannerService,
  } = deps;

  const router = Router();
  router.use(express.json());

  const { isAdmin, assertAdmin } = createAdminAuth({ httpAuth, permissions });

  /**
   * Authorises a terminal action (assign/archive). `unresolved` entities have
   * no escalation actor, so only admins may act on them; every other status
   * goes through {@link assertUserIsResolvedActor}.
   */
  async function assertUserCanResolve(
    entityId: string,
    credentials: BackstageCredentials<BackstageUserPrincipal>,
  ): Promise<void> {
    const userRef = credentials.principal.userEntityRef;
    const entity = await store.getEntityById(entityId);
    if (entity?.current_status === 'unresolved') {
      if (!(await isAdmin(credentials))) {
        throw new NotAllowedError(
          `User ${userRef} is not authorised to act on unresolved entity ${entityId}`,
        );
      }
      return;
    }
    await assertUserIsResolvedActor(entityId, userRef);
  }

  /** Asserts that the authenticated user is the resolved actor on the entity's currently-active queue entry. */
  async function assertUserIsResolvedActor(
    entityId: string,
    userRef: string,
  ): Promise<void> {
    const entity = await store.getEntityById(entityId);
    if (!entity) {
      throw new NotFoundError(`Entity ${entityId} not found`);
    }

    const activeEntry = await store.findActiveQueueEntry(entityId);
    // No active entry (or no resolved actor on it) means there is nobody the
    // request can authenticate as. Only the resolved actor may act, so refuse
    // with 403 rather than 501.
    if (!activeEntry || activeEntry.resolved_actor_ref === null) {
      throw new NotAllowedError(
        `User ${userRef} is not authorised to act on entity ${entityId} (no active escalation actor)`,
      );
    }
    if (activeEntry.resolved_actor_ref !== userRef) {
      throw new NotAllowedError(
        `User ${userRef} does not match resolved actor on entity ${entityId}`,
      );
    }
  }

  // ── Reject ───────────────────────────────────────────────────────────────

  router.post('/entities/:id/escalation/reject', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const actorRef = credentials.principal.userEntityRef;

    const parsed = escalationRejectSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());

    await assertUserIsResolvedActor(req.params.id, actorRef);

    const result = await escalationService.escalationReject(
      req.params.id,
      actorRef,
      parsed.data.reason,
    );
    res
      .status(200)
      .json({ entity: result.entity, nextActor: result.nextActor });
  });

  // ── Assign ───────────────────────────────────────────────────────────────

  router.post('/entities/:id/escalation/assign', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const actorRef = credentials.principal.userEntityRef;

    const parsed = escalationAssignSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());

    await assertUserCanResolve(req.params.id, credentials);

    const result = await escalationService.escalationAssign(
      req.params.id,
      parsed.data.ownerRef,
      actorRef,
    );
    res.status(200).json({ entity: result.entity });
  });

  // ── Archive ──────────────────────────────────────────────────────────────

  router.post('/entities/:id/escalation/archive', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const actorRef = credentials.principal.userEntityRef;

    const parsed = escalationArchiveSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());

    await assertUserCanResolve(req.params.id, credentials);

    const result = await escalationService.escalationArchive(
      req.params.id,
      parsed.data.assigneeRef,
      actorRef,
    );
    res.status(200).json({ entity: result.entity });
  });

  // ── Suggest ──────────────────────────────────────────────────────────────

  router.post('/entities/:id/escalation/suggest', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const actorRef = credentials.principal.userEntityRef;

    const parsed = escalationSuggestSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());

    await assertUserIsResolvedActor(req.params.id, actorRef);

    const result = await escalationService.escalationSuggest(
      req.params.id,
      parsed.data.suggestedOwnerRef,
      parsed.data.reason,
      actorRef,
    );
    res.status(200).json({ entity: result.entity, proposal: result.proposal });
  });

  // ── Manager chain ────────────────────────────────────────────────────────

  /**
   * GET /escalation/manager-chain?ref=<entityRef>
   * Returns the full AD manager chain for each member of the entity's owner team.
   */
  router.get('/escalation/manager-chain', async (req, res) => {
    // Exposes org-chart data and fans out catalog calls: admin-only.
    await assertAdmin(req);
    const entityRef =
      typeof req.query.ref === 'string' ? req.query.ref : undefined;
    if (!entityRef) throw new InputError('Missing required query param: ref');

    const entity = await catalogService.getEntityByRef(entityRef);
    if (!entity) throw new NotFoundError(`Entity not found: ${entityRef}`);

    const ownerRef = entity.spec?.owner;
    if (!ownerRef) {
      res.json({ entityRef, ownerRef: null, chains: [] });
      return;
    }

    const normalizedOwnerRef = ownerRef.includes(':')
      ? ownerRef
      : `group:default/${ownerRef}`;

    const members = await catalogService.getGroupMembersWithTitles(
      normalizedOwnerRef,
    );

    const chains = await Promise.all(
      members.map(async member => {
        const chain: { userRef: string; jobTitle: string | undefined }[] = [];
        let currentRef: string | undefined = member.userRef;
        const visited = new Set<string>();
        while (currentRef && !visited.has(currentRef)) {
          visited.add(currentRef);
          const managerRef = await catalogService.getManagerRef(currentRef);
          if (!managerRef) break;
          const jobTitle = await catalogService.getUserJobTitle(managerRef);
          chain.push({ userRef: managerRef, jobTitle });
          currentRef = managerRef;
        }
        return {
          memberRef: member.userRef,
          memberJobTitle: member.jobTitle,
          chain,
        };
      }),
    );

    res.json({ entityRef, ownerRef: normalizedOwnerRef, chains });
  });

  // ── Retrigger ────────────────────────────────────────────────────────────

  /** Rescans the entity via `scanService.scanEntity(...)` before delegating to `escalationService.escalationRetrigger`. */
  router.post('/entities/:id/escalation/retrigger', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const actorRef = credentials.principal.userEntityRef;

    const parsed = escalationRetriggerSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());

    const fallbackActors = config.fallbackActors ?? [];
    if (fallbackActors.length === 0) {
      throw new BackstageNotImplementedError(
        'Retrigger unavailable — no fallbackActors configured',
      );
    }

    const isAuthorised = await isUserInAnyFallbackActor(
      catalogService,
      actorRef,
      fallbackActors,
    );
    if (!isAuthorised) {
      throw new NotAllowedError(`User ${actorRef} is not in fallbackActors`);
    }

    const entity = await store.getEntityById(req.params.id);
    if (!entity) {
      throw new NotFoundError(`Entity ${req.params.id} not found`);
    }
    if (entity.current_status !== 'unresolved') {
      throw new ConflictError(
        `Entity ${req.params.id} is not in unresolved state`,
      );
    }

    // gracefully when no scanner is wired (test paths without the scanner)
    // — the service then runs the cancel + BFS rebuild branches.
    let scanResult;
    if (scannerService) {
      try {
        scanResult = await scannerService.scanEntity(entity.entity_ref);
      } catch (err) {
        // Scanner failure is non-fatal — log and let the service fall back
        // to the rebuild path.
        scanResult = undefined;
      }
    }

    const result = await escalationService.escalationRetrigger(
      req.params.id,
      actorRef,
      scanResult,
    );
    res.status(200).json({
      action: result.action,
      entityStatus: result.entityStatus,
      proposalsCreated: result.proposalsCreated,
    });
  });

  return router;
}

/** Returns true if `userRef` is a member of any of the `fallbackActors` entries. */
async function isUserInAnyFallbackActor(
  catalogService: CatalogService,
  userRef: string,
  fallbackActors: string[],
): Promise<boolean> {
  const userRefLower = userRef.toLowerCase();
  for (const ref of fallbackActors) {
    if (ref.toLowerCase() === userRefLower) {
      return true;
    }
    if (ref.startsWith('group:')) {
      // eslint-disable-next-line no-await-in-loop -- short-circuit on first hit
      const isMember = await catalogService.isUserMemberOfGroup(userRef, ref);
      if (isMember) return true;
    }
  }
  return false;
}
