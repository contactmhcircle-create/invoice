<?php
/**
 * Roles and capabilities — port of server/auth/permissions.ts. The map lives in
 * code so a change to who can do what is a reviewable diff, not a silent row
 * edit. Enforcement is server-side on every operation.
 */

declare(strict_types=1);

const ALL_CAPABILITIES = [
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

const ROLE_CAPABILITIES = [
    'owner' => ALL_CAPABILITIES,

    // Vetting sees personal data because the job requires it; never money.
    'compliance' => [
        'workers.read', 'workers.write', 'workers.pii',
        'compliance.read', 'compliance.write',
        'clients.read', 'rota.read',
        'documents.read', 'documents.write',
        'audit.read', 'statutory.read',
    ],

    // Rotas and timesheet entry; no personal data, no rates.
    'scheduler' => [
        'workers.read', 'compliance.read',
        'rota.read', 'rota.write',
        'clients.read',
        'timesheets.read', 'timesheets.write',
        'documents.read', 'documents.write',
    ],

    // Money; worker personal data masked to what billing needs.
    'finance' => [
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

    'readonly' => [
        'workers.read', 'compliance.read', 'rota.read', 'clients.read',
        'timesheets.read', 'invoices.read', 'purchases.read', 'reports.read',
        'statutory.read', 'settings.read', 'documents.read',
    ],
];

const ROLE_LABELS = [
    'owner' => 'Owner',
    'compliance' => 'Compliance & vetting',
    'scheduler' => 'Scheduler',
    'finance' => 'Finance',
    'readonly' => 'Read only',
];

const ROLE_DESCRIPTIONS = [
    'owner' => 'Full access, including managing other users and company settings.',
    'compliance' => 'Workers, licences, right to work and BS 7858 screening. No rates, margins or invoices.',
    'scheduler' => 'Rotas, shift allocation and timesheet entry. Worker personal details are hidden.',
    'finance' => 'Invoicing, purchases, reports and statutory returns. No worker personal data.',
    'readonly' => 'Can view everything except worker personal details. Cannot change anything.',
];

function role_can(string $role, string $capability): bool {
    return in_array($capability, ROLE_CAPABILITIES[$role] ?? [], true);
}

function capabilities_for(string $role): array {
    return ROLE_CAPABILITIES[$role] ?? [];
}

/** Personal-data fields stripped for anyone without workers.pii. */
const PII_FIELDS = [
    'date_of_birth', 'ni_number', 'address_1', 'address_2', 'city', 'postcode',
    'bank_account_name', 'bank_sort_code', 'bank_account_number',
    'emergency_contact_name', 'emergency_contact_phone',
    'workerDateOfBirth', 'workerNiNumber', 'workerAddress', 'workerPostcode',
];

const PII_REDACTED = '••••••';

function mask_worker_pii(mixed $value, bool $allowed): mixed {
    if ($allowed || $value === null || !is_array($value)) return $value;

    $out = [];
    foreach ($value as $key => $val) {
        if (is_string($key) && in_array($key, PII_FIELDS, true)) {
            $out[$key] = ($val === null || $val === '') ? $val : PII_REDACTED;
        } elseif (is_array($val)) {
            $out[$key] = mask_worker_pii($val, $allowed);
        } else {
            $out[$key] = $val;
        }
    }
    return $out;
}
