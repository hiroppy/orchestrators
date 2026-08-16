import { and, asc, eq } from "drizzle-orm";

import type { WatcherDatabase } from "./database.ts";
import { services, statuses } from "./schema.ts";

export function getSelectableStatuses(db: WatcherDatabase, serviceName: string): string[] {
  return db
    .select({ name: statuses.name })
    .from(statuses)
    .innerJoin(services, eq(statuses.serviceId, services.id))
    .where(
      and(eq(services.name, serviceName), eq(services.active, true), eq(statuses.selectable, true)),
    )
    .orderBy(asc(statuses.sortOrder))
    .all()
    .map(({ name }) => name);
}
