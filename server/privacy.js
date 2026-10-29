import path from 'node:path';
import { run } from './exec.js';
import { HOME } from './paths.js';

// TCC service ids, their readable names, the System Settings pane, and the tccutil service name.
export const services = {
  kTCCServiceCamera:['Camera', 'Privacy_Camera', 'Camera'],
  kTCCServiceMicrophone:['Microphone', 'Privacy_Microphone', 'Microphone'],
  kTCCServiceScreenCapture:['Screen Recording', 'Privacy_ScreenCapture', 'ScreenCapture'],
  kTCCServiceAccessibility:['Accessibility', 'Privacy_Accessibility', 'Accessibility'],
  kTCCServiceSystemPolicyAllFiles:['Full Disk Access', 'Privacy_AllFiles', 'SystemPolicyAllFiles'],
  kTCCServiceListenEvent:['Input Monitoring', 'Privacy_ListenEvent', 'ListenEvent'],
  kTCCServicePostEvent:['Input Monitoring (send)', 'Privacy_ListenEvent', 'PostEvent'],
  kTCCServiceAppleEvents:['Automation', 'Privacy_Automation', 'AppleEvents'],
  kTCCServiceAddressBook:['Contacts', 'Privacy_Contacts', 'AddressBook'],
  kTCCServiceCalendar:['Calendars', 'Privacy_Calendars', 'Calendar'],
  kTCCServiceReminders:['Reminders', 'Privacy_Reminders', 'Reminders'],
  kTCCServicePhotos:['Photos', 'Privacy_Photos', 'Photos'],
  kTCCServiceSystemPolicyDesktopFolder:['Desktop Folder', 'Privacy_FilesAndFolders', 'SystemPolicyDesktopFolder'],
  kTCCServiceSystemPolicyDocumentsFolder:['Documents Folder', 'Privacy_FilesAndFolders', 'SystemPolicyDocumentsFolder'],
  kTCCServiceSystemPolicyDownloadsFolder:['Downloads Folder', 'Privacy_FilesAndFolders', 'SystemPolicyDownloadsFolder'],
  kTCCServiceSystemPolicyNetworkVolumes:['Network Volumes', 'Privacy_FilesAndFolders', 'SystemPolicyNetworkVolumes'],
  kTCCServiceSystemPolicyRemovableVolumes:['Removable Volumes', 'Privacy_FilesAndFolders', 'SystemPolicyRemovableVolumes'],
  kTCCServiceDeveloperTool:['Developer Tools', 'Privacy_DevTools', 'DeveloperTool'],
  kTCCServiceBluetoothAlways:['Bluetooth', 'Privacy_Bluetooth', 'BluetoothAlways'],
  kTCCServiceLocation:['Location', 'Privacy_LocationServices', 'Location'],
};
const authNames = { 0:'denied', 1:'unknown', 2:'allowed', 3:'limited' };

const databases = () => [
  { scope:'user', file:path.join(HOME, 'Library/Application Support/com.apple.TCC/TCC.db') },
  { scope:'system', file:'/Library/Application Support/com.apple.TCC/TCC.db' },
];

// macOS only lets processes with Full Disk Access read TCC.db, so a failure here is expected and explained.
export async function permissions() {
  const rows = [];
  const errors = [];
  for (const db of databases()) {
    const result = await run('/usr/bin/sqlite3', ['-readonly', '-json', db.file, 'SELECT service, client, client_type, auth_value, last_modified FROM access']);
    if (!result.ok) { errors.push({ scope:db.scope, error:result.stderr.trim() }); continue; }
    rows.push(...parseRows(result.stdout, db.scope));
  }
  return { rows, needsFullDiskAccess:rows.length === 0 && errors.length > 0, errors, node:process.execPath };
}

export function parseRows(text, scope) {
  let data = [];
  try { data = JSON.parse(text || '[]'); } catch {}
  return data.map(r => ({
    scope, service:r.service, label:services[r.service]?.[0] || r.service.replace(/^kTCCService/, ''),
    client:r.client, isPath:r.client_type === 1, status:authNames[r.auth_value] || String(r.auth_value),
    modified:r.last_modified ? r.last_modified * 1000 : null, revocable:Boolean(services[r.service]) && r.client_type === 0,
  }));
}

export async function revoke(service, client) {
  const entry = services[service];
  if (!entry) throw Object.assign(new Error('Unknown permission.'), { status:400 });
  if (!/^[\w.-]+$/.test(client)) throw Object.assign(new Error('Only app bundle ids can be reset.'), { status:400 });
  const result = await run('/usr/bin/tccutil', ['reset', entry[2], client]);
  if (!result.ok) throw Object.assign(new Error((result.stderr || 'tccutil failed').trim()), { status:400 });
  return { ok:true };
}

// macOS has no API to grant these; the most we can do is open the right pane.
export async function openPane(service) {
  const pane = services[service]?.[1] || 'Privacy';
  await run('/usr/bin/open', [`x-apple.systempreferences:com.apple.preference.security?${pane}`]);
}
