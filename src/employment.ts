import { EntityRegistry, type Entity } from "./entities.js";
import { invalidInput } from "./runtime/action.js";

export interface EmployeeDef {
  id: string;
  name?: string;
  role?: string;
  /** Pay per payroll run, in game currency. Must be positive. */
  wage: number;
  /** Id of the employing business entity. */
  employerId: string;
}

export interface Employee {
  id: string;
  name: string;
  role: string | undefined;
  wage: number;
  employerId: string;
  /** Earned but unspent pay, held on the entity. Topped up by payroll. */
  balance: number;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function optionalStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function defineEmployee(entities: EntityRegistry, def: EmployeeDef): Employee {
  if (!def.id || typeof def.id !== "string") throw invalidInput("Employee must have an id");
  if (typeof def.wage !== "number" || !(def.wage > 0)) {
    throw invalidInput(`Wage must be positive, got ${String(def.wage)}`);
  }
  if (!def.employerId || typeof def.employerId !== "string") {
    throw invalidInput("Employee must have an employerId");
  }
  if (entities.has(def.id)) throw invalidInput(`Entity already exists: ${def.id}`);
  // The employer must exist and be a business: 404 otherwise.
  entities.get(def.employerId, "business");
  entities.define({
    id: def.id,
    kind: "employee",
    name: def.name ?? def.id,
    attributes: {
      role: def.role ?? null,
      wage: def.wage,
      employerId: def.employerId,
      balance: 0,
    },
  });
  return getEmployee(entities, def.id);
}

/** Live view: balance writes go straight to the entity's attributes. */
export function getEmployee(entities: EntityRegistry, id: string): Employee {
  const entity = entities.get(id, "employee");
  return viewEmployee(entity);
}

export function employeesOf(entities: EntityRegistry, businessId: string): Employee[] {
  return entities
    .list("employee")
    .filter((e) => e.attributes.employerId === businessId)
    .map(viewEmployee);
}

function viewEmployee(entity: Entity): Employee {
  return {
    id: entity.id,
    get name(): string {
      return entity.name;
    },
    get role(): string | undefined {
      return optionalStr(entity.attributes.role);
    },
    get wage(): number {
      return num(entity.attributes.wage, 0);
    },
    get employerId(): string {
      return entity.attributes.employerId as string;
    },
    get balance(): number {
      return num(entity.attributes.balance, 0);
    },
    set balance(v: number) {
      entity.attributes.balance = v;
    },
  };
}
