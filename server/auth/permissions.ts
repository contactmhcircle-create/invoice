/**
 * Roles and capabilities.
 *
 * The map lives in code rather than the database so that a change to who can do
 * what shows up in a git diff and a code review, not as a silent row edit.
 *
 * Enforcement is server-side on every request. The interface hides what a user
 * cannot do, but hiding a button is presentation, not security.
 */

export type Capability =
  | 'workers.read' | 'workers.write' | 'workers.pii'
  | 'compliance.read' | 'compliance.write'
  | 'rota.read' | 'rota.write'
  | 'clients.read' | 'clients.write'
  | 'rates.read' | 'rates.write'
  | 'timesheets.read' | 'timesheets.write' | 'timesheets.approve'
  | 'invoices.read' | 'invoices.write' | 'invoices.issue' | 'invoices.void'
  | 'purchases.read' | 'purchases.write'
  | 'reports.read'
  | 'statutory.read' | 'statutory.write'
  | 'settings.read' | 'settings.write'
  | 'users.manage'
  | 'audit.read'
  | 'enquiry.generate'
  | 'documents.read' | 'documents.write';

export type Role = 'owner' | 'compliance' | 'scheduler' | 'finance' | 'readonly';

const ALL: Capability[] = [
  'workers.read', 'workers.write', 'workers.pii',
  'compliance.read', 'compliance.write',
  'rota.read', 'rota.write',
  'clients.read', 'clients.write',
  'rates.read', 'rates.write',
  'timesheets.read', 'timesheets.write', 'timesheets.approve',
  'invoices.read', 'invoices.write', 'invoices.issue', 'invoices.void',
  'purchases.read', 'purchases.write',
  'reports.read',
  'statutory.read', 'statutory.write',
  'settings.read', 'settings.write',
  'users.manage',
  'audit.read',
  'enquiry.generate',
  'documents.read', 'documents.write',
];

export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  // Everything, including creating other users.
  owner: ALL,

  // Vetting and screening. Sees worker personal data because the job requires
  // it, but no rates, margins or invoices — there is no reason for a vetting
  // officer to know what a client is charged.
  compliance: [
    'workers.read', 'workers.write', 'workers.pii',
    'compliance.read', 'compliance.write',
    'clients.read',
    'rota.read',
    'documents.read', 'documents.write',
    'audit.read',
    'statutory.read',
  ],

  // Builds rotas and keys timesheets. Needs to know who is placeable, not their
  // National Insurance number.
  scheduler: [
    'workers.read',
    'compliance.read',
    'rota.read', 'rota.write',
    'clients.read',
    'timesheets.read', 'timesheets.write',
    'documents.read', 'documents.write',
  ],

  // Billing and reporting. Worker personal details are masked down to the name,
  // which is all an invoice needs.
  finance: [
    'workers.read',
    'clients.read', 'clients.write',
    'rates.read', 'rates.write',
    'rota.read',
    'timesheets.read', 'timesheets.approve',
    'invoices.read', 'invoices.write', 'invoices.issue', 'invoices.void',
    'purchases.read', 'purchases.write',
    'reports.read',
    'statutory.read', 'statutory.write',
    'settings.read',
    'documents.read',
    'audit.read',
    'enquiry.generate',
  ],

  readonly: [
    'workers.read', 'compliance.read', 'rota.read', 'clients.read',
    'timesheets.read', 'invoices.read', 'purchases.read', 'reports.read',
    'statutory.read', 'settings.read', 'documents.read',
  ],
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  compliance: 'Compliance & vetting',
  scheduler: 'Scheduler',
  finance: 'Finance',
  readonly: 'Read only',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: 'Full access, including managing other users and company settings.',
  compliance: 'Workers, licences, right to work and BS 7858 screening. No rates, margins or invoices.',
  scheduler: 'Rotas, shift allocation and timesheet entry. Worker personal details are hidden.',
  finance: 'Invoicing, purchases, reports and statutory returns. Worker personal details are hidden.',
  readonly: 'Can view everything except worker personal details. Cannot change anything.',
};

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

export function capabilitiesFor(role: Role): Capability[] {
  return ROLE_CAPABILITIES[role] ?? [];
}

/**
 * Roles that must have two-factor enabled before they can do anything.
 *
 * Anyone who can see worker personal data or move money is in scope. Read-only
 * accounts still see commercially sensitive information, so in practice this is
 * everyone — but the list is explicit so the reasoning is visible rather than
 * assumed.
 */
export const ROLES_REQUIRING_2FA: Role[] = ['owner', 'compliance', 'scheduler', 'finance', 'readonly'];

export function requiresTwoFactor(role: Role): boolean {
  return ROLES_REQUIRING_2FA.includes(role);
}

/**
 * Fields on a worker record that count as personal data under UK GDPR and are
 * stripped for anyone without `workers.pii`.
 *
 * A scheduler needs to know Grace Okonkwo is placeable on Tuesday. They do not
 * need her date of birth, National Insurance number, home address or bank
 * details, and the smaller the number of people who can see those, the smaller
 * the consequence of any one account being compromised.
 */
const PII_FIELDS = [
  'date_of_birth', 'ni_number', 'address_1', 'address_2', 'city', 'postcode',
  'bank_account_name', 'bank_sort_code', 'bank_account_number',
  'emergency_contact_name', 'emergency_contact_phone',
  'workerDateOfBirth', 'workerNiNumber', 'workerAddress', 'workerPostcode',
];

const PII_REDACTED = '••••••';

export function maskWorkerPii<T>(value: T, allowed: boolean): T {
  if (allowed || value == null) return value;

  if (Array.isArray(value)) {
    return value.map((v) => maskWorkerPii(v, allowed)) as unknown as T;
  }
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (PII_FIELDS.includes(key)) {
      out[key] = val == null || val === '' ? val : PII_REDACTED;
    } else if (val && typeof val === 'object') {
      out[key] = maskWorkerPii(val, allowed);
    } else {
      out[key] = val;
    }
  }
  return out as T;
}
