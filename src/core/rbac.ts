import { PRINCIPALS, WRITE_GRANTS, type Entity } from './policy.ts';
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

  // Reads come from the annotation. Writes need naming in WRITE_GRANTS.
  const permitted = intent.annotations.readOnly || WRITE_GRANTS[p.role].includes(intentName);
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
 * WRITE_GRANTS holds plain strings — so renaming an intent would silently drop
 * its grant and the pipeline would just stop creating invoices at 07:30.
 * Fail to start instead.
 */
export function validatePolicy(): string[] {
  const errs: string[] = [];

  for (const [role, names] of Object.entries(WRITE_GRANTS)) {
    for (const n of names) {
      const i = INTENTS[n];
      if (!i) errs.push(`WRITE_GRANTS.${role} names unknown intent "${n}"`);
      else if (i.annotations.readOnly)
        errs.push(`WRITE_GRANTS.${role} grants read-only "${n}" — reads derive from annotations, remove it`);
    }
  }

  for (const [p, cfg] of Object.entries(PRINCIPALS)) {
    if (!WRITE_GRANTS[cfg.role]) errs.push(`principal ${p} has unknown role "${cfg.role}"`);
    if (cfg.entities !== '*' && cfg.entities.length === 0)
      errs.push(`principal ${p} is scoped to zero entities — remove it instead`);
  }

  // A write intent nobody can call is dead config, and usually a typo.
  for (const [name, i] of Object.entries(INTENTS)) {
    if (!i.annotations.readOnly && !Object.values(WRITE_GRANTS).flat().includes(name))
      errs.push(`write intent "${name}" is granted to no role`);
  }

  return errs;
}
