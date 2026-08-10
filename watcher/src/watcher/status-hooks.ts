import type { ResolvedStatusHookConfig } from "../config/runtime.ts";
import type { StatusHookContext, StatusHookHelpers } from "../domain/types.ts";

export type { StatusHookContext } from "../domain/types.ts";

export interface StatusHookResult {
  output?: string;
  error?: unknown;
}

export async function runStatusHooks(
  hooks: ResolvedStatusHookConfig[],
  context: StatusHookContext,
  helpers: StatusHookHelpers,
): Promise<StatusHookResult[]> {
  const matchingHooks = hooks.filter(
    ({ status }) => normalizeStatus(status) === normalizeStatus(context.transition.to),
  );

  return Promise.all(
    matchingHooks.map(async ({ run, timeoutMs }) => {
      try {
        const value = await withTimeout(Promise.resolve(run(context, helpers)), timeoutMs);
        const output = typeof value === "string" ? value.trim() : "";
        return output ? { output } : {};
      } catch (error) {
        return { error };
      }
    }),
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Status hook timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function normalizeStatus(status: string): string {
  return status.trim().toLocaleLowerCase();
}
