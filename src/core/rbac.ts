import { PRINCIPALS, GRANTS, type Entity } from './policy.ts';
import { INTENTS } from './intents.ts';

export type Decision =
  | { allow: true; role: string }
  | { allow: false; reason: string; status: number };

/**
 * The single authorisation decision. Deny by default at every step.
 * Called from exactly one place — see src/server.ts. One call site is a
 * security property, not a missing abstraction.
 */
export function authorize(principal: string, intentName: string, args: unknown): Decision {
  const p = PRINCIPALS[principal];
  if (!p) return { allow: false, reason: 'unknown principal', status: 403 };

  const intent = INTENTS[intentName];
  if (!intent) return { allow: false, reason: 'unknown intent', status: 404 };

  // Both reads and writes come from GRANTS now — nothing is implicit. A role
  // sees exactly the intents named for it, full stop.
  const permitted = GRANTS[p.role].includes(intentName);
  if (!permitted) return { allow: false, reason: `role ${p.role} may not ${intentName}`, status: 403 };

  // Entity scope. Every intent takes an entity, so a missing one is a bug.
  const entity = (args as { entity?: Entity } | null)?.entity;
  if (!entity) return { allow: false, reason: 'no entity in arguments', status: 400 };
  if (p.entities !== '*' && !p.entities.includes(entity)) {
    return { allow: false, reason: `role ${p.role} is not scoped to ${entity}`, status: 403 };
  }

  return { allow: true, role: p.role };
}

/**
 * Boot check. TypeScript already catches a bad entity or role name, but
 * GRANTS holds plain strings — so renaming an intent would silently drop its
 * grant and a caller would just start getting 403s. Fail to start instead.
 */
export function validatePolicy(): string[] {
  const errs: string[] = [];

  for (const [role, names] of Object.entries(GRANTS)) {
    for (const n of names) {
      if (!INTENTS[n]) errs.push(`GRANTS.${role} names unknown intent "${n}"`);
    }
  }

  for (const [p, cfg] of Object.entries(PRINCIPALS)) {
    if (!GRANTS[cfg.role]) errs.push(`principal ${p} has unknown role "${cfg.role}"`);
    if (cfg.entities !== '*' && cfg.entities.length === 0)
      errs.push(`principal ${p} is scoped to zero entities — remove it instead`);
  }

  // An intent nobody can call is dead config, and usually a typo or a
  // forgotten grant on a newly added tool.
  for (const name of Object.keys(INTENTS)) {
    if (!Object.values(GRANTS).flat().includes(name))
      errs.push(`intent "${name}" is granted to no role`);
  }

  return errs;
}
