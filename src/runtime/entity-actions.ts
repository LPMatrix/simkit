import type { ActionDef } from "./action.js";
import { requirements } from "./action.js";
import type { Entity } from "../entities.js";

/**
 * Actions that act on a generic entity (see ActionDef.targetKind).
 * Nothing here knows about a specific domain: a "course" is just an entity of
 * that kind with attributes like `capacity`, `enrolled`, and `fee`.
 */

function numberAttr(entity: Entity, key: string, fallback: number): number {
  const v = entity.attributes[key];
  return typeof v === "number" ? v : fallback;
}

export const enrolAction: ActionDef<void> = {
  id: "enrol",
  description: "Enrol in a course entity. Takes a seat and pays its fee, if any.",
  targetKind: "course",
  requires: [
    {
      id: "not-enrolled",
      check: ({ actor, target }) =>
        actor.enrolments[target!.id] ? `Already enrolled in ${target!.name}` : null,
    },
    {
      id: "seat",
      check: ({ target }) => {
        const capacity = numberAttr(target!, "capacity", Infinity);
        const enrolled = numberAttr(target!, "enrolled", 0);
        return enrolled < capacity ? null : `${target!.name} is full`;
      },
    },
    requirements.hasCash(({ target }) => numberAttr(target!, "fee", 0)),
  ],
  execute({ sim, actor, target }) {
    const course = target as Entity;
    const fee = numberAttr(course, "fee", 0);
    actor.touch();
    if (fee > 0) actor.wallet.debit(fee, actor.stamp(`tuition:${course.id}`));
    actor.enrolments[course.id] = true;
    course.attributes.enrolled = numberAttr(course, "enrolled", 0) + 1;
    sim.emit("ENROLLED", { courseId: course.id, fee }, actor.id);
  },
};

export const ENTITY_ACTIONS: ActionDef<unknown>[] = [enrolAction as ActionDef<unknown>];
