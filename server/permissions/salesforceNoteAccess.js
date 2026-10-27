import { config } from "../config.js";
import { PermissionDeniedError } from "./userPermissions.js";

export function canCreateSalesforceNotes(user, settings = config.salesforce) {
  if (!settings.noteWritesEnabled || !settings.configured) return false;
  if (!user?.permissions?.supportingRecords) return false;

  const allowedGroups = new Set(settings.noteWriterGroups || []);
  if (!allowedGroups.size) return false;
  return (user.groups || []).some((group) => allowedGroups.has(String(group)));
}

export function requireSalesforceNoteCreate(request, response, next) {
  if (canCreateSalesforceNotes(request.user)) {
    next();
    return;
  }
  next(new PermissionDeniedError("This account is not permitted to add Salesforce claim notes."));
}
