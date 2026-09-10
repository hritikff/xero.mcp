import { PRINCIPALS, GRANTS, ENTITIES, type Entity } from './policy.ts';
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

    // The naming contract itself: a role called "X-invoice-creator" must mean
    // exactly what it says. This is what makes the rename load-bearing rather
    // than cosmetic — a role whose name claims one entity but whose principal
    // is scoped to something else (or to everything) fails the boot instead
    // of quietly misleading whoever reads the role name to decide what it
    // can touch. This is the exact class of mix-up that prompted the rename.
    const namedEntity = ENTITIES.find((e) => cfg.role === `${e}-invoice-creator`);
    if (namedEntity) {
      if (cfg.entities === '*' || cfg.entities.length !== 1 || cfg.entities[0] !== namedEntity) {
        errs.push(
          `principal ${p} has role "${cfg.role}" (implies entities: ["${namedEntity}"]) ` +
          `but is actually scoped to ${cfg.entities === '*' ? "'*'" : JSON.stringify(cfg.entities)}`,
        );
      }
    }
  }

  // An intent nobody can call is dead config, and usually a typo or a
  // forgotten grant on a newly added tool.
  for (const name of Object.keys(INTENTS)) {
    if (!Object.values(GRANTS).flat().includes(name))
      errs.push(`intent "${name}" is granted to no role`);
  }

  return errs;
}
