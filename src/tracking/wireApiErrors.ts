// Wires api/client.ts's error hook to storage/repository.ts. Lives in
// tracking/, not api/ or storage/, so neither of those layers has to depend
// on the other — see docs/AUDIT.md §11 on keeping API retrieval and storage
// separate.

import { onApiError } from "../api/client";
import { recordApiError } from "../storage/repository";

export function wireApiErrorsToStorage(): void {
  onApiError((err) => {
    recordApiError({
      occurredAt: Math.floor(Date.now() / 1000),
      host: err.host,
      url: err.url,
      statusCode: err.statusCode,
      message: err.message,
      attempt: err.attempt,
    });
  });
}
