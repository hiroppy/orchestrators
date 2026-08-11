import { eq } from "drizzle-orm";

import type { ResolvedLinearTeamConfig, ServiceDefinition } from "../domain/types.ts";
import type { WatcherDatabase } from "./database.ts";
import { services, statuses } from "./schema.ts";

export function syncDefinitions(
  db: WatcherDatabase,
  serviceDefinitions: ServiceDefinition[],
  linearTeams: Record<string, ResolvedLinearTeamConfig>,
  now: Date,
): void {
  const timestamp = now.toISOString();

  db.transaction((tx) => {
    tx.update(services)
      .set({ active: false, updatedAt: timestamp })
      .where(eq(services.active, true))
      .run();
    tx.update(statuses)
      .set({ selectable: false, sortOrder: null, updatedAt: timestamp })
      .where(eq(statuses.selectable, true))
      .run();

    for (const service of serviceDefinitions) {
      tx.insert(services)
        .values({
          name: service.name,
          url: service.url,
          active: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: services.name,
          set: { url: service.url, active: true, updatedAt: timestamp },
        })
        .run();
    }

    for (const definition of serviceDefinitions) {
      const service = tx.select().from(services).where(eq(services.name, definition.name)).get()!;
      linearTeams[definition.linearTeam].statuses.forEach((name, sortOrder) => {
        tx.insert(statuses)
          .values({
            serviceId: service.id,
            name,
            sortOrder,
            selectable: true,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoUpdate({
            target: [statuses.serviceId, statuses.name],
            set: { sortOrder, selectable: true, updatedAt: timestamp },
          })
          .run();
      });
    }
  });
}
