<?php
/**
 * The operation registry — port of server/rpc.ts, plus the draft-invoice
 * editing operations. Each operation declares the capability it needs, so
 * authorisation is a property of the operation rather than something a route
 * handler can forget; an operation with no capability fails closed.
 *
 * Entry shape: [capability, readOnly, maskPii, handler(db, user, payload)].
 */

declare(strict_types=1);

class AuthorisationError extends RuntimeException {}

function rpc_registry(): array {
    static $ops = null;
    if ($ops !== null) return $ops;

    $ops = [];
    $op = function (string $channel, string $capability, bool $readOnly, bool $maskPii, callable $fn) use (&$ops): void {
        $ops[$channel] = ['capability' => $capability, 'readOnly' => $readOnly,
            'maskPii' => $maskPii, 'fn' => $fn];
    };

    // --- Session and account -------------------------------------------------
    $op('me', 'authenticated', true, false, fn($db, $user) =>
        $user + ['capabilities' => capabilities_for($user['role'])]);

    $op('me:sessions', 'authenticated', true, false, fn($db, $user) =>
        active_sessions_for($db, $user['id']));

    $op('me:changePassword', 'authenticated', false, false, function ($db, $user, $p) {
        $login = account_login($db, ['email' => $user['email'], 'password' => $p['currentPassword'] ?? '']);
        // A correct password on a 2FA account returns totp_required — still proof.
        if (!$login['ok'] && ($login['reason'] ?? '') !== 'totp_required') {
            throw new DomainException('Your current password is not correct.');
        }
        set_password($db, $user['id'], $p['newPassword'] ?? '', $user['id']);
        revoke_all_sessions($db, $user['id'], 'Password changed');
        return true;
    });

    $op('me:beginTwoFactor', 'authenticated', false, false, fn($db, $user) =>
        begin_two_factor($db, $user['id']));
    $op('me:confirmTwoFactor', 'authenticated', false, false, fn($db, $user, $p) =>
        confirm_two_factor($db, $user['id'], (string) ($p['code'] ?? '')));

    // --- User management -----------------------------------------------------
    $op('users:list', 'users.manage', true, false, fn($db) => list_users($db));
    $op('users:create', 'users.manage', false, false, fn($db, $user, $p) =>
        create_user($db, $p + ['createdBy' => $user['id']]));
    $op('users:update', 'users.manage', false, false, function ($db, $user, $p) {
        update_user($db, $p['id'], $p, $user['id']);
        return true;
    });
    $op('users:resetPassword', 'users.manage', false, false, function ($db, $user, $p) {
        set_password($db, $p['id'], $p['password'] ?? '', $user['id']);
        q($db, 'UPDATE users SET must_change_password = 1 WHERE id = ?', [$p['id']]);
        revoke_all_sessions($db, $p['id'], 'Password reset by an owner');
        return true;
    });
    $op('users:revokeSessions', 'users.manage', false, false, fn($db, $user, $p) =>
        ['revoked' => revoke_all_sessions($db, $p['id'], "Signed out by {$user['email']}")]);

    // --- Company and settings ------------------------------------------------
    $op('company:get', 'settings.read', true, false, fn($db) =>
        row($db, 'SELECT * FROM company WHERE id = 1'));

    $op('company:update', 'settings.write', false, false, function ($db, $user, $p) {
        $allowed = ['legal_name', 'trading_name', 'company_number', 'incorporated_on',
            'registered_address_1', 'registered_address_2', 'registered_city', 'registered_postcode',
            'phone', 'email', 'website', 'brand_colour',
            'vat_registered', 'vat_number', 'vat_registered_from', 'vat_scheme', 'vat_basis',
            'paye_reference', 'accounts_office_ref',
            'bank_name', 'bank_account_name', 'bank_sort_code', 'bank_account_number', 'bank_iban',
            'base_currency', 'default_payment_terms_days', 'invoice_footer', 'invoice_terms'];
        $before = row($db, 'SELECT * FROM company WHERE id = 1');
        $fields = array_values(array_filter($allowed, fn($f) => array_key_exists($f, $p)));
        if ($fields) {
            $sets = implode(', ', array_map(fn($f) => "$f = ?", $fields));
            q($db, "UPDATE company SET $sets, updated_at = ? WHERE id = 1",
                [...array_map(fn($f) => $p[$f], $fields), now_instant()]);
            record_audit($db, [
                'entityType' => 'company', 'entityId' => '1', 'action' => 'updated',
                'summary' => 'Company details updated: ' . implode(', ', $fields),
                'actor' => $user['id'], 'before' => $before, 'after' => $p,
            ]);
        }
        return row($db, 'SELECT * FROM company WHERE id = 1');
    });

    $op('nmw:list', 'settings.read', true, false, fn($db) =>
        rows($db, 'SELECT * FROM nmw_rates ORDER BY effective_from DESC, band'));
    $op('nmw:set', 'settings.write', false, false, function ($db, $user, $p) {
        q($db, 'INSERT INTO nmw_rates (id, effective_from, band, rate_pence, created_at) VALUES (?,?,?,?,?)
                ON CONFLICT(effective_from, band) DO UPDATE SET rate_pence = excluded.rate_pence',
            [new_id('nmw'), $p['effectiveFrom'], $p['band'], (int) $p['ratePence'], now_instant()]);
        record_audit($db, [
            'entityType' => 'nmw_rate', 'entityId' => "{$p['effectiveFrom']}_{$p['band']}", 'action' => 'updated',
            'summary' => 'NMW ' . str_replace('_', ' ', $p['band']) . " from {$p['effectiveFrom']} set to £"
                . number_format($p['ratePence'] / 100, 2),
            'actor' => $user['id'],
        ]);
        return true;
    });

    // --- Organisations -------------------------------------------------------
    $op('orgs:list', 'clients.read', true, false, function ($db, $user, $p) {
        $where = [];
        if (!empty($p['isClient'])) $where[] = 'is_client = 1';
        if (!empty($p['isUmbrella'])) $where[] = 'is_umbrella = 1';
        return rows($db, 'SELECT * FROM organisations'
            . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY name');
    });

    $op('orgs:get', 'clients.read', true, false, function ($db, $user, $p) {
        $org = row($db, 'SELECT * FROM organisations WHERE id = ?', [$p['id']]);
        if (!$org) return null;
        return $org + [
            'sites' => rows($db, 'SELECT * FROM sites WHERE organisation_id = ? ORDER BY name', [$p['id']]),
            'dueDiligence' => due_diligence_status($db, $p['id']),
            'assignments' => rows($db, 'SELECT * FROM assignments WHERE client_org_id = ? ORDER BY starts_on DESC', [$p['id']]),
        ];
    });

    $op('orgs:save', 'clients.write', false, false, function ($db, $user, $p) {
        $now = now_instant();
        $fields = ['name', 'legal_name', 'company_number', 'vat_number', 'is_client', 'is_end_client',
            'is_umbrella', 'is_supplier', 'address_1', 'address_2', 'city', 'postcode', 'country',
            'contact_name', 'contact_email', 'contact_phone', 'currency', 'payment_terms_days',
            'self_bills_us', 'po_required', 'notes', 'status'];
        $bools = ['is_client', 'is_end_client', 'is_umbrella', 'is_supplier', 'self_bills_us', 'po_required'];
        foreach ($bools as $b) if (array_key_exists($b, $p)) $p[$b] = !empty($p[$b]) ? 1 : 0;

        if (!empty($p['id'])) {
            $before = row($db, 'SELECT * FROM organisations WHERE id = ?', [$p['id']]);
            $present = array_values(array_filter($fields, fn($f) => array_key_exists($f, $p)));
            if ($present) {
                $sets = implode(', ', array_map(fn($f) => "$f = ?", $present));
                q($db, "UPDATE organisations SET $sets, updated_at = ? WHERE id = ?",
                    [...array_map(fn($f) => $p[$f], $present), $now, $p['id']]);
            }
            record_audit($db, [
                'entityType' => 'organisation', 'entityId' => $p['id'], 'action' => 'updated',
                'summary' => ($p['name'] ?? 'Organisation') . ' updated',
                'actor' => $user['id'], 'before' => $before, 'after' => $p,
            ]);
            return $p['id'];
        }

        $id = new_id('org');
        q($db, "INSERT INTO organisations (id, name, legal_name, company_number, vat_number, is_client,
                  is_end_client, is_umbrella, is_supplier, address_1, address_2, city, postcode, country,
                  contact_name, contact_email, contact_phone, currency, payment_terms_days, self_bills_us,
                  po_required, notes, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [$id, $p['name'], $p['legal_name'] ?? null, $p['company_number'] ?? null, $p['vat_number'] ?? null,
             $p['is_client'] ?? 0, $p['is_end_client'] ?? 0, $p['is_umbrella'] ?? 0, $p['is_supplier'] ?? 0,
             $p['address_1'] ?? null, $p['address_2'] ?? null, $p['city'] ?? null, $p['postcode'] ?? null,
             $p['country'] ?? 'United Kingdom', $p['contact_name'] ?? null, $p['contact_email'] ?? null,
             $p['contact_phone'] ?? null, $p['currency'] ?? 'GBP', (int) ($p['payment_terms_days'] ?? 30),
             $p['self_bills_us'] ?? 0, $p['po_required'] ?? 0, $p['notes'] ?? null, $now, $now]);
        record_audit($db, [
            'entityType' => 'organisation', 'entityId' => $id, 'action' => 'created',
            'summary' => "{$p['name']} added", 'actor' => $user['id'], 'after' => $p,
        ]);
        return $id;
    });

    $op('orgs:recordDueDiligence', 'clients.write', false, false, fn($db, $user, $p) =>
        record_due_diligence($db, $p + ['performedBy' => $p['performedBy'] ?? $user['name']], $user['id']));

    $op('orgs:delete', 'clients.write', false, false, function ($db, $user, $p) {
        delete_organisation($db, $p['id'], $user['id']);
        return true;
    });

    $op('sites:delete', 'clients.write', false, false, function ($db, $user, $p) {
        delete_site($db, $p['id'], $user['id']);
        return true;
    });

    $op('sites:save', 'clients.write', false, false, function ($db, $user, $p) {
        $now = now_instant();
        if (!empty($p['id'])) {
            $fields = array_values(array_filter(
                ['name', 'address_1', 'address_2', 'city', 'postcode', 'contact_name',
                 'contact_phone', 'access_notes', 'status'],
                fn($f) => array_key_exists($f, $p)));
            if ($fields) {
                $sets = implode(', ', array_map(fn($f) => "$f = ?", $fields));
                q($db, "UPDATE sites SET $sets, updated_at = ? WHERE id = ?",
                    [...array_map(fn($f) => $p[$f], $fields), $now, $p['id']]);
            }
            return $p['id'];
        }
        $id = new_id('site');
        q($db, 'INSERT INTO sites (id, organisation_id, name, address_1, address_2, city, postcode,
                  contact_name, contact_phone, access_notes, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            [$id, $p['organisation_id'], $p['name'], $p['address_1'] ?? null, $p['address_2'] ?? null,
             $p['city'] ?? null, $p['postcode'] ?? null, $p['contact_name'] ?? null,
             $p['contact_phone'] ?? null, $p['access_notes'] ?? null, $now, $now]);
        return $id;
    });

    // --- Workers -------------------------------------------------------------
    $op('workers:list', 'workers.read', true, true, function ($db, $user, $p) {
        $result = rows($db, 'SELECT w.*, u.name AS umbrella_name,
                  (SELECT MIN(expires_on) FROM worker_licences l
                    WHERE l.worker_id = w.id AND l.status = \'valid\') AS licence_expires
            FROM workers w LEFT JOIN organisations u ON u.id = w.umbrella_org_id'
            . (!empty($p['status']) ? ' WHERE w.status = ?' : '')
            . ' ORDER BY w.last_name, w.first_name',
            !empty($p['status']) ? [$p['status']] : []);
        return array_map(function ($w) use ($db) {
            $report = check_worker($db, $w['id']);
            return $w + [
                'placeable' => $report['placeable'],
                'blockerCount' => count($report['blockers']),
                'warningCount' => count($report['warnings']),
                'topIssue' => $report['blockers'][0]['title'] ?? $report['warnings'][0]['title'] ?? null,
            ];
        }, $result);
    });

    $op('workers:get', 'workers.read', true, true, function ($db, $user, $p) {
        $worker = row($db, 'SELECT w.*, u.name AS umbrella_name FROM workers w
            LEFT JOIN organisations u ON u.id = w.umbrella_org_id WHERE w.id = ?', [$p['id']]);
        if (!$worker) return null;
        return $worker + [
            'compliance' => check_worker($db, $p['id'], $p['atDate'] ?? null),
            'licences' => rows($db, 'SELECT * FROM worker_licences WHERE worker_id = ? ORDER BY expires_on DESC', [$p['id']]),
            'rightToWork' => rows($db, 'SELECT * FROM worker_rtw WHERE worker_id = ? ORDER BY checked_on DESC', [$p['id']]),
            'screening' => rows($db, 'SELECT * FROM screening_checks WHERE worker_id = ?', [$p['id']]),
            'documents' => rows($db, "SELECT * FROM documents WHERE entity_type = 'worker' AND entity_id = ? ORDER BY uploaded_at DESC", [$p['id']]),
            'kid' => rows($db, 'SELECT id, version, issued_on FROM key_information_documents WHERE worker_id = ? ORDER BY version DESC', [$p['id']]),
            'recentShifts' => rows($db, 'SELECT s.*, a.title FROM shifts s JOIN assignments a ON a.id = s.assignment_id
                WHERE s.worker_id = ? ORDER BY s.starts_at DESC LIMIT 30', [$p['id']]),
        ];
    });

    $op('workers:delete', 'workers.write', false, false, function ($db, $user, $p) {
        delete_worker($db, $p['id'], $user['id']);
        return true;
    });

    $op('workers:save', 'workers.write', false, false, function ($db, $user, $p) {
        $now = now_instant();
        $fields = ['first_name', 'last_name', 'known_as', 'date_of_birth', 'ni_number', 'email',
            'phone', 'address_1', 'address_2', 'city', 'postcode', 'engagement_type', 'umbrella_org_id',
            'limited_company_no', 'ir35_status', 'ir35_assessed_on', 'ir35_notes', 'default_pay_rate_pence',
            'wtr_opt_out', 'wtr_opt_out_signed_on', 'bank_account_name', 'bank_sort_code',
            'bank_account_number', 'emergency_contact_name', 'emergency_contact_phone', 'status', 'notes'];

        if (!empty($p['id'])) {
            // Someone without workers.pii must not blank personal fields they saw as dots.
            $editable = role_can($user['role'], 'workers.pii') ? $fields
                : array_values(array_diff($fields, PII_FIELDS));
            $before = row($db, 'SELECT * FROM workers WHERE id = ?', [$p['id']]);
            $present = array_values(array_filter($editable, fn($f) => array_key_exists($f, $p)));
            if ($present) {
                $sets = implode(', ', array_map(fn($f) => "$f = ?", $present));
                q($db, "UPDATE workers SET $sets, updated_at = ? WHERE id = ?",
                    [...array_map(fn($f) => $p[$f], $present), $now, $p['id']]);
            }
            record_audit($db, [
                'entityType' => 'worker', 'entityId' => $p['id'], 'action' => 'updated',
                'summary' => 'Worker record updated: ' . implode(', ', $present),
                'actor' => $user['id'], 'before' => $before, 'after' => $p,
            ]);
            // An umbrella link or engagement change can clear the last blocker.
            activate_if_clear($db, $p['id'], $user['id']);
            return $p['id'];
        }

        $id = new_id('wkr');
        q($db, 'INSERT INTO workers (id, reference, first_name, last_name, known_as, date_of_birth, ni_number,
                  email, phone, address_1, address_2, city, postcode, engagement_type, umbrella_org_id,
                  default_pay_rate_pence, status, notes, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [$id, allocate_number($db, 'worker', $id), $p['first_name'], $p['last_name'],
             $p['known_as'] ?? null, $p['date_of_birth'] ?? null, $p['ni_number'] ?? null,
             $p['email'] ?? null, $p['phone'] ?? null, $p['address_1'] ?? null, $p['address_2'] ?? null,
             $p['city'] ?? null, $p['postcode'] ?? null, $p['engagement_type'] ?? 'umbrella',
             $p['umbrella_org_id'] ?: null, $p['default_pay_rate_pence'] ?? null,
             $p['status'] ?? 'onboarding', $p['notes'] ?? null, $now, $now]);
        ensure_screening_rows($db, $id);
        record_audit($db, [
            'entityType' => 'worker', 'entityId' => $id, 'action' => 'created',
            'summary' => "Worker added: {$p['first_name']} {$p['last_name']}",
            'actor' => $user['id'], 'after' => $p,
        ]);
        return $id;
    });

    $op('workers:addLicence', 'compliance.write', false, false, function ($db, $user, $p) {
        $id = new_id('lic');
        $now = now_instant();
        q($db, 'INSERT INTO worker_licences (id, worker_id, sector, licence_number, issued_on, expires_on,
                  verified_on, verified_by, status, notes, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            [$id, $p['worker_id'], $p['sector'], $p['licence_number'], $p['issued_on'] ?: null,
             $p['expires_on'], $p['verified_on'] ?: null, $p['verified_by'] ?? $user['name'],
             $p['status'] ?? 'valid', $p['notes'] ?? null, $now, $now]);
        record_audit($db, [
            'entityType' => 'worker', 'entityId' => $p['worker_id'], 'action' => 'licence_added',
            'summary' => 'SIA ' . str_replace('_', ' ', $p['sector'])
                . " licence {$p['licence_number']} recorded, expires {$p['expires_on']}",
            'actor' => $user['id'], 'after' => $p,
        ]);
        activate_if_clear($db, $p['worker_id'], $user['id']);
        return $id;
    });

    $op('workers:addRtw', 'compliance.write', false, false, function ($db, $user, $p) {
        $id = new_id('rtw');
        q($db, 'INSERT INTO worker_rtw (id, worker_id, method, share_code, document_type, document_ref,
                  checked_on, checked_by, outcome, expires_on, recheck_due_on, notes, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [$id, $p['worker_id'], $p['method'], $p['share_code'] ?? null,
             $p['document_type'] ?? null, $p['document_ref'] ?? null, $p['checked_on'],
             $p['checked_by'] ?? $user['name'], $p['outcome'], $p['expires_on'] ?: null,
             $p['recheck_due_on'] ?: null, $p['notes'] ?? null, now_instant()]);
        record_audit($db, [
            'entityType' => 'worker', 'entityId' => $p['worker_id'], 'action' => 'rtw_recorded',
            'summary' => "Right to work check ({$p['method']}) recorded — outcome {$p['outcome']}",
            'actor' => $user['id'], 'after' => $p,
        ]);
        activate_if_clear($db, $p['worker_id'], $user['id']);
        return $id;
    });

    $op('workers:setScreening', 'compliance.write', false, false, function ($db, $user, $p) {
        set_screening_element($db, $p['workerId'], $p['element'], $p['status'],
            array_diff_key($p, array_flip(['workerId', 'element', 'status'])) + ['actor' => $user['id'], 'verifiedBy' => $user['name']]);
        activate_if_clear($db, $p['workerId'], $user['id']);
        return check_worker($db, $p['workerId']);
    });

    $op('workers:issueKid', 'compliance.write', false, false, function ($db, $user, $p) {
        $w = row($db, 'SELECT w.*, u.name AS umbrella_name FROM workers w
            LEFT JOIN organisations u ON u.id = w.umbrella_org_id WHERE w.id = ?', [$p['workerId']]);
        if (!$w) throw new DomainException('Worker not found');
        $c = row($db, 'SELECT * FROM company WHERE id = 1');
        $version = (int) (scalar($db, 'SELECT MAX(version) FROM key_information_documents WHERE worker_id = ?',
            [$p['workerId']]) ?? 0) + 1;
        $rate = $w['default_pay_rate_pence']
            ? '£' . number_format($w['default_pay_rate_pence'] / 100, 2) . ' per hour'
            : 'as agreed per assignment';
        $contractType = $w['engagement_type'] === 'umbrella' ? 'Supplied via an umbrella company'
            : ($w['engagement_type'] === 'paye' ? 'Contract for services, PAYE' : 'Off-payroll engagement');
        $html = '<h2>Key Information Document</h2>'
            . '<p>Provided under the Conduct of Employment Agencies and Employment Businesses '
            . 'Regulations 2003. This is not a contract of employment.</p><table>'
            . '<tr><th>Employment business</th><td>' . esc($c['legal_name'] ?? 'Cerviz Ltd')
            . (($c['company_number'] ?? null) ? ' (company no. ' . esc($c['company_number']) . ')' : '') . '</td></tr>'
            . '<tr><th>Your name</th><td>' . esc("{$w['first_name']} {$w['last_name']}") . '</td></tr>'
            . '<tr><th>Type of contract</th><td>' . $contractType . '</td></tr>'
            . '<tr><th>Who pays you</th><td>' . esc($w['umbrella_name'] ?? $c['legal_name'] ?? 'Cerviz Ltd') . '</td></tr>'
            . '<tr><th>Rate of pay</th><td>' . $rate . '</td></tr>'
            . '<tr><th>How often you are paid</th><td>Weekly, following approval of your timesheet</td></tr>'
            . '<tr><th>Statutory deductions</th><td>Income tax and National Insurance are deducted by whoever operates PAYE on your pay.</td></tr>'
            . '<tr><th>Holiday entitlement</th><td>Statutory holiday, accruing at 12.07% of hours worked.</td></tr>'
            . '<tr><th>Issued on</th><td>' . today_iso() . '</td></tr></table>';

        $id = new_id('kid');
        q($db, 'INSERT INTO key_information_documents (id, worker_id, version, issued_on, issued_by,
                  engagement_type, pay_rate_pence, umbrella_org_id, content_html, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)',
            [$id, $p['workerId'], $version, today_iso(), $user['name'], $w['engagement_type'],
             $w['default_pay_rate_pence'], $w['umbrella_org_id'], $html, now_instant()]);
        record_audit($db, [
            'entityType' => 'worker', 'entityId' => $p['workerId'], 'action' => 'kid_issued',
            'summary' => "Key Information Document version $version issued", 'actor' => $user['id'],
        ]);
        return ['id' => $id, 'version' => $version, 'html' => $html];
    });

    $op('workers:compliance', 'compliance.read', true, false, fn($db, $user, $p) =>
        check_worker($db, $p['id'], $p['atDate'] ?? null, $p['sector'] ?? null));

    $op('compliance:dashboard', 'compliance.read', true, true, fn($db, $user, $p) =>
        expiring_compliance($db, (int) ($p['withinDays'] ?? 60)));

    // --- Assignments and rates ----------------------------------------------
    $op('assignments:list', 'clients.read', true, false, fn($db) =>
        rows($db, "SELECT a.*, o.name AS client_name, s.name AS site_name,
                  (SELECT COUNT(*) FROM shifts sh WHERE sh.assignment_id = a.id
                    AND sh.status IN ('planned','allocated')) AS upcoming_shifts
            FROM assignments a
            JOIN organisations o ON o.id = a.client_org_id
            LEFT JOIN sites s ON s.id = a.site_id
            ORDER BY a.status, a.starts_on DESC"));

    $op('assignments:get', 'clients.read', true, false, function ($db, $user, $p) {
        $a = row($db, 'SELECT a.*, o.name AS client_name, s.name AS site_name FROM assignments a
            JOIN organisations o ON o.id = a.client_org_id
            LEFT JOIN sites s ON s.id = a.site_id WHERE a.id = ?', [$p['id']]);
        if (!$a) return null;
        return $a + [
            'rates' => role_can($user['role'], 'rates.read')
                ? rows($db, "SELECT * FROM rates WHERE scope = 'assignment' AND scope_id = ? ORDER BY effective_from DESC", [$p['id']])
                : [],
            'supplyChain' => supply_chain_for($db, $p['id']),
            'fillRate' => fill_rate($db, $p['id'], add_days(today_iso(), -28), add_days(today_iso(), 28)),
        ];
    });

    $op('assignments:delete', 'clients.write', false, false, function ($db, $user, $p) {
        delete_assignment($db, $p['id'], $user['id']);
        return true;
    });

    $op('assignments:save', 'clients.write', false, false, function ($db, $user, $p) {
        $now = now_instant();
        if (!empty($p['id'])) {
            $fields = array_values(array_filter(
                ['title', 'site_id', 'sector', 'role', 'required_licence_sector', 'starts_on',
                 'ends_on', 'po_reference', 'currency', 'use_rate_bands', 'bank_holiday_multiplier',
                 'overtime_after_minutes', 'overtime_multiplier', 'min_shift_minutes', 'invoice_grouping',
                 'notes', 'status'],
                fn($f) => array_key_exists($f, $p)));
            if ($fields) {
                $sets = implode(', ', array_map(fn($f) => "$f = ?", $fields));
                q($db, "UPDATE assignments SET $sets, updated_at = ? WHERE id = ?",
                    [...array_map(fn($f) => $p[$f], $fields), $now, $p['id']]);
            }
            record_audit($db, [
                'entityType' => 'assignment', 'entityId' => $p['id'], 'action' => 'updated',
                'summary' => 'Assignment updated: ' . implode(', ', $fields),
                'actor' => $user['id'], 'after' => $p,
            ]);
            return $p['id'];
        }

        $id = new_id('asg');
        q($db, "INSERT INTO assignments (id, reference, client_org_id, site_id, title, sector, role,
                  required_licence_sector, starts_on, ends_on, po_reference, currency, use_rate_bands,
                  min_shift_minutes, notes, status, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [$id, allocate_number($db, 'assignment', $id), $p['client_org_id'], $p['site_id'] ?? null,
             $p['title'], $p['sector'] ?? 'security', $p['role'] ?? null,
             $p['required_licence_sector'] ?: null, $p['starts_on'], $p['ends_on'] ?? null,
             $p['po_reference'] ?? null, $p['currency'] ?? 'GBP', !empty($p['use_rate_bands']) ? 1 : 0,
             $p['min_shift_minutes'] ?? null, $p['notes'] ?? null, $p['status'] ?? 'active', $now, $now]);

        if (!empty($p['charge_rate_pence']) && !empty($p['pay_rate_pence'])
            && role_can($user['role'], 'rates.write')) {
            set_rate($db, ['scope' => 'assignment', 'scopeId' => $id,
                'chargeRatePence' => (int) $p['charge_rate_pence'],
                'payRatePence' => (int) $p['pay_rate_pence'], 'effectiveFrom' => $p['starts_on']]);
        }
        record_audit($db, [
            'entityType' => 'assignment', 'entityId' => $id, 'action' => 'created',
            'summary' => "Assignment created: {$p['title']}", 'actor' => $user['id'], 'after' => $p,
        ]);
        return $id;
    });

    $op('rates:set', 'rates.write', false, false, fn($db, $user, $p) => set_rate($db, $p));
    $op('supplyChain:get', 'clients.read', true, false, fn($db, $user, $p) =>
        supply_chain_for($db, $p['assignmentId']));
    $op('supplyChain:set', 'clients.write', false, false, function ($db, $user, $p) {
        set_supply_chain($db, $p['assignmentId'], $p['links'], $user['id']);
        return supply_chain_for($db, $p['assignmentId']);
    });

    // --- Shifts --------------------------------------------------------------
    $op('shifts:list', 'rota.read', true, false, function ($db, $user, $p) {
        $from = $p['from'] ?? add_days(today_iso(), -7);
        $to = $p['to'] ?? add_days(today_iso(), 21);
        $params = [$from, $to];
        $extra = '';
        if (!empty($p['assignmentId'])) { $extra = ' AND s.assignment_id = ?'; $params[] = $p['assignmentId']; }
        $result = rows($db, "SELECT s.*, a.title AS assignment_title, a.required_licence_sector,
                  o.name AS client_name, si.name AS site_name, w.first_name, w.last_name
            FROM shifts s
            JOIN assignments a ON a.id = s.assignment_id
            JOIN organisations o ON o.id = a.client_org_id
            LEFT JOIN sites si ON si.id = s.site_id
            LEFT JOIN workers w ON w.id = s.worker_id
            WHERE date(s.starts_at) BETWEEN ? AND ?$extra
            ORDER BY s.starts_at", $params);
        if (role_can($user['role'], 'rates.read')) return $result;
        return array_map(fn($r) => array_diff_key($r, array_flip([
            'charge_rate_pence', 'pay_rate_pence', 'rate_source',
            'charge_rate_override_pence', 'pay_rate_override_pence'])), $result);
    });

    $op('shifts:delete', 'rota.write', false, false, function ($db, $user, $p) {
        delete_shift($db, $p['id'], $user['id']);
        return true;
    });

    $op('shifts:create', 'rota.write', false, false, fn($db, $user, $p) => create_shift($db, $p, $user['id']));
    $op('shifts:createSeries', 'rota.write', false, false, function ($db, $user, $p) {
        $created = [];
        $date = $p['from'];
        $guard = 0;
        while ($date <= $p['to'] && $guard++ < 400) {
            $dow = (int) iso_date($date)->format('w');
            if (empty($p['daysOfWeek']) || in_array($dow, $p['daysOfWeek'], true)) {
                $created[] = create_shift($db, [
                    'assignmentId' => $p['assignmentId'], 'siteId' => $p['siteId'] ?? null,
                    'startsAt' => "{$date}T{$p['startTime']}:00", 'endsAt' => "{$date}T{$p['endTime']}:00",
                    'breakMinutes' => (int) ($p['breakMinutes'] ?? 0),
                ], $user['id']);
            }
            $date = add_days($date, 1);
        }
        return $created;
    });
    $op('shifts:eligibleWorkers', 'rota.read', true, false, fn($db, $user, $p) =>
        eligible_workers($db, $p['shiftId']));
    $op('shifts:checkAllocation', 'rota.read', true, false, fn($db, $user, $p) =>
        check_allocation($db, $p['shiftId'], $p['workerId']));
    $op('shifts:allocate', 'rota.write', false, false, fn($db, $user, $p) =>
        allocate_worker($db, $p['shiftId'], $p['workerId'],
            array_diff_key($p, array_flip(['shiftId', 'workerId'])), $user['id']));
    $op('shifts:release', 'rota.write', false, false, function ($db, $user, $p) {
        release_worker($db, $p['shiftId'], $p['reason'], $user['id']);
        return true;
    });
    $op('shifts:mark', 'rota.write', false, false, function ($db, $user, $p) {
        mark_shift_status($db, $p['shiftId'], $p['status'],
            array_diff_key($p, array_flip(['shiftId', 'status'])), $user['id']);
        return true;
    });
    $op('shifts:replace', 'rota.write', false, false, fn($db, $user, $p) =>
        replace_shift($db, $p['shiftId'], $p['workerId'], $p['reason'], $user['id']));

    // --- Timesheets ----------------------------------------------------------
    $op('timesheets:list', 'timesheets.read', true, false, fn($db, $user, $p) =>
        rows($db, "SELECT t.*, a.title AS assignment_title, o.name AS client_name,
                  w.first_name, w.last_name,
                  (SELECT COUNT(*) FROM documents d WHERE d.entity_type = 'timesheet'
                    AND d.entity_id = t.id AND d.category = 'signed_timesheet') AS scan_count
            FROM timesheets t
            JOIN assignments a ON a.id = t.assignment_id
            JOIN organisations o ON o.id = a.client_org_id
            JOIN workers w ON w.id = t.worker_id"
            . (!empty($p['status']) ? ' WHERE t.status = ?' : '')
            . ' ORDER BY t.week_ending DESC, w.last_name',
            !empty($p['status']) ? [$p['status']] : []));

    $op('timesheets:get', 'timesheets.read', true, false, fn($db, $user, $p) =>
        timesheet_with_lines($db, $p['id']));
    $op('timesheets:create', 'timesheets.write', false, false, fn($db, $user, $p) =>
        create_timesheet($db, $p, $user['name']));
    $op('timesheets:populate', 'timesheets.write', false, false, fn($db, $user, $p) =>
        populate_from_shifts($db, $p['id']));
    $op('timesheets:addLine', 'timesheets.write', false, false, fn($db, $user, $p) =>
        timesheet_add_line($db, $p['timesheetId'], $p['line']));
    $op('timesheets:removeLine', 'timesheets.write', false, false, function ($db, $user, $p) {
        timesheet_remove_line($db, $p['timesheetId'], $p['lineId']);
        return true;
    });
    $op('timesheets:approve', 'timesheets.approve', false, false, function ($db, $user, $p) {
        approve_timesheet($db, $p['id'],
            ($p['input'] ?? []) + ['approvedBy' => $user['name']], $p['opts'] ?? [], $user['id']);
        return timesheet_with_lines($db, $p['id']);
    });
    $op('timesheets:delete', 'timesheets.write', false, false, function ($db, $user, $p) {
        delete_timesheet($db, $p['id'], $user['id']);
        return true;
    });

    $op('timesheets:reopen', 'timesheets.approve', false, false, function ($db, $user, $p) {
        reopen_timesheet($db, $p['id'], $p['reason'], $user['id']);
        return true;
    });
    $op('timesheets:dispute', 'timesheets.write', false, false, function ($db, $user, $p) {
        dispute_timesheet($db, $p['id'], $p['reason'], $user['id']);
        return true;
    });
    $op('timesheets:unbilled', 'timesheets.read', true, false, fn($db, $user, $p) =>
        unbilled_timesheets($db, $p['clientOrgId'] ?? null));

    // --- Invoicing -----------------------------------------------------------
    $op('invoices:list', 'invoices.read', true, false, function ($db, $user, $p) {
        refresh_overdue_statuses($db);
        return rows($db, 'SELECT i.*, o.name AS client_name FROM invoices i
            JOIN organisations o ON o.id = i.client_org_id'
            . (!empty($p['status']) ? ' WHERE i.status = ?' : '')
            . ' ORDER BY i.created_at DESC',
            !empty($p['status']) ? [$p['status']] : []);
    });
    $op('invoices:get', 'invoices.read', true, false, fn($db, $user, $p) =>
        invoice_with_detail($db, $p['id']));
    $op('invoices:createFromTimesheets', 'invoices.write', false, false, fn($db, $user, $p) =>
        create_invoice_from_timesheets($db, $p, $user['id']));
    $op('invoices:createManual', 'invoices.write', false, false, fn($db, $user, $p) =>
        create_manual_invoice($db, $p, $user['id']));
    $op('invoices:addLine', 'invoices.write', false, false, fn($db, $user, $p) =>
        invoice_add_manual_line($db, $p['invoiceId'], $p['line']));
    $op('invoices:updateLine', 'invoices.write', false, false, function ($db, $user, $p) {
        invoice_update_line($db, $p['invoiceId'], $p['lineId'], $p['changes']);
        return true;
    });
    $op('invoices:removeLine', 'invoices.write', false, false, function ($db, $user, $p) {
        invoice_remove_line($db, $p['invoiceId'], $p['lineId']);
        return true;
    });
    $op('invoices:deleteDraft', 'invoices.write', false, false, function ($db, $user, $p) {
        delete_draft_invoice($db, $p['id'], $user['id']);
        return true;
    });

    $op('invoices:updateDraft', 'invoices.write', false, false, function ($db, $user, $p) {
        invoice_update_draft($db, $p['id'], $p['changes'], $user['id']);
        return invoice_with_detail($db, $p['id']);
    });
    $op('invoices:issue', 'invoices.issue', false, false, function ($db, $user, $p) {
        $number = issue_invoice($db, $p['id'], $user['id']);
        record_audit($db, [
            'entityType' => 'invoice', 'entityId' => $p['id'], 'action' => 'issued_by',
            'summary' => "Invoice $number issued by {$user['name']} ({$user['email']})",
            'actor' => $user['id'],
        ]);
        return $number;
    });
    $op('invoices:void', 'invoices.void', false, false, function ($db, $user, $p) {
        void_invoice($db, $p['id'], $p['reason'], $user['id']);
        return true;
    });
    $op('invoices:recordPayment', 'invoices.write', false, false, fn($db, $user, $p) =>
        record_payment($db, $p, $user['id']));
    $op('invoices:creditNote', 'invoices.write', false, false, fn($db, $user, $p) =>
        create_credit_note($db, $p, $user['id']));
    $op('invoices:issueCreditNote', 'invoices.issue', false, false, fn($db, $user, $p) =>
        issue_credit_note($db, $p['id'], $user['id']));
    $op('invoices:agedDebtors', 'invoices.read', true, false, fn($db) => aged_debtors($db));
    $op('invoices:reminders', 'invoices.read', true, false, fn($db) => due_reminders($db));
    $op('invoices:markReminderSent', 'invoices.write', false, false, function ($db, $user, $p) {
        q($db, 'UPDATE invoice_reminders SET sent_at = ?, channel = ? WHERE id = ?',
            [now_instant(), $p['channel'] ?? 'email', $p['id']]);
        return true;
    });

    // --- Purchases -----------------------------------------------------------
    $op('purchases:list', 'purchases.read', true, false, fn($db) =>
        rows($db, 'SELECT p.*, o.name AS supplier FROM purchase_invoices p
            JOIN organisations o ON o.id = p.organisation_id ORDER BY p.invoice_date DESC'));
    $op('purchases:create', 'purchases.write', false, false, fn($db, $user, $p) =>
        create_purchase_invoice($db, $p, $user['id']));
    $op('purchases:addLine', 'purchases.write', false, false, fn($db, $user, $p) =>
        add_purchase_line($db, $p['purchaseInvoiceId'], $p['line']));
    $op('purchases:match', 'purchases.read', false, false, fn($db, $user, $p) =>
        match_purchase_to_timesheets($db, $p['id']));
    $op('purchases:approve', 'purchases.write', false, false, function ($db, $user, $p) {
        approve_purchase_invoice($db, $p['id'], $user['name']);
        return true;
    });
    $op('purchases:agedCreditors', 'purchases.read', true, false, fn($db) => aged_creditors($db));

    $op('selfBills:list', 'purchases.read', true, false, fn($db) =>
        rows($db, 'SELECT s.*, o.name AS agency FROM self_bills s
            JOIN organisations o ON o.id = s.organisation_id ORDER BY s.received_on DESC'));
    $op('selfBills:record', 'purchases.write', false, false, fn($db, $user, $p) =>
        record_self_bill($db, $p, $user['id']));
    $op('selfBills:reconcile', 'purchases.read', false, false, fn($db, $user, $p) =>
        reconcile_self_bill($db, $p['id']));

    // --- Reporting -----------------------------------------------------------
    $op('reports:margin', 'reports.read', true, false, fn($db, $user, $p) =>
        margin_report($db, $p['from'], $p['to']));
    $op('reports:trialBalance', 'reports.read', true, false, fn($db, $user, $p) =>
        trial_balance($db, $p['asOf'] ?? null));
    $op('reports:profitAndLoss', 'reports.read', true, false, fn($db, $user, $p) =>
        profit_and_loss($db, $p['from'], $p['to']));
    $op('reports:balanceSheet', 'reports.read', true, false, fn($db, $user, $p) =>
        balance_sheet($db, $p['asOf'] ?? null));
    $op('reports:vatThreshold', 'reports.read', true, false, fn($db) => vat_threshold_status($db));
    $op('reports:vatReturn', 'reports.read', true, false, fn($db, $user, $p) =>
        vat_return_worksheet($db, $p['from'], $p['to']));
    $op('reports:sequenceAudit', 'reports.read', true, false, fn($db, $user, $p) =>
        audit_sequence($db, $p['docType'] ?? 'invoice'));

    // --- Statutory -----------------------------------------------------------
    $op('statutory:intermediaryObligations', 'statutory.read', false, false, fn($db) =>
        intermediary_obligations($db));
    $op('statutory:intermediaryReport', 'statutory.read', true, true, fn($db, $user, $p) =>
        generate_intermediary_report($db, $p['from'], $p['to']));
    $op('statutory:filings', 'statutory.read', false, false, fn($db) => upcoming_filings($db));
    $op('statutory:markFilingSubmitted', 'statutory.write', false, false, function ($db, $user, $p) {
        mark_filing_submitted($db, $p['id'], $p['submittedOn'] ?? null, $p['reference'] ?? null, $user['id']);
        return true;
    });

    // --- Bank ----------------------------------------------------------------
    $op('tide:reconciliation', 'reports.read', true, false, fn($db) => reconciliation_view($db));
    $op('tide:autoMatch', 'purchases.write', false, false, fn($db) => auto_match_transactions($db));
    $op('tide:confirmMatch', 'purchases.write', false, false, function ($db, $user, $p) {
        confirm_bank_match($db, $p['bankTxnId'], $p['target'], $user['id']);
        return true;
    });

    // --- Evidence and integrity ---------------------------------------------
    $op('documents:list', 'documents.read', true, false, fn($db, $user, $p) =>
        rows($db, 'SELECT * FROM documents WHERE entity_type = ? AND entity_id = ? ORDER BY uploaded_at DESC',
            [$p['entityType'], $p['entityId']]));
    $op('documents:verify', 'documents.read', true, false, fn($db) => verify_documents($db));

    $op('audit:verify', 'audit.read', true, false, fn($db) => verify_audit_chain($db));
    $op('audit:trail', 'audit.read', true, false, fn($db, $user, $p) =>
        audit_trail_for($db, $p['entityType'], $p['entityId']));
    $op('audit:recent', 'audit.read', true, false, fn($db, $user, $p) =>
        rows($db, 'SELECT id, at, actor, actor_name, actor_email, action, entity_type, entity_id, summary
            FROM audit_log_with_actor ORDER BY id DESC LIMIT ?',
            [min((int) ($p['limit'] ?? 200), 1000)]));

    $op('enquiryPack:build', 'enquiry.generate', true, false, fn($db, $user, $p) =>
        build_enquiry_pack($db, $p['from'], $p['to']));

    $op('backup:list', 'settings.read', true, false, fn($db, $user, $p, $ctx) =>
        list_backups($ctx['dataDir'] . '/backups'));
    $op('backup:now', 'settings.write', true, false, function ($db, $user, $p, $ctx) {
        $result = backup_database($db, $ctx['dataDir'] . '/backups');
        record_audit($db, [
            'entityType' => 'backup', 'entityId' => $result['path'], 'action' => 'requested',
            'summary' => "Backup taken on request by {$user['name']}", 'actor' => $user['id'],
        ]);
        return $result;
    });

    // --- Dashboard -----------------------------------------------------------
    $op('dashboard:summary', 'authenticated', false, true, function ($db, $user) {
        $role = $user['role'];
        $out = ['asOf' => today_iso(), 'auditChainOk' => verify_audit_chain($db)['ok']];

        if (role_can($role, 'invoices.read')) {
            refresh_overdue_statuses($db);
            $aged = aged_debtors($db);
            $out['outstandingPence'] = $aged['totalOutstanding'];
            $out['overduePence'] = $aged['buckets']['days1to30'] + $aged['buckets']['days31to60']
                + $aged['buckets']['days61to90'] + $aged['buckets']['over90'];
        }
        if (role_can($role, 'timesheets.read')) {
            $unbilled = unbilled_timesheets($db);
            $out['unbilledCount'] = count($unbilled);
            $out['unbilledPence'] = role_can($role, 'rates.read')
                ? array_sum(array_map(fn($t) => (int) $t['charge_total_pence'], $unbilled)) : null;
        }
        if (role_can($role, 'rota.read')) {
            $out['unfilledShifts'] = (int) scalar($db, "SELECT COUNT(*) FROM shifts
                WHERE worker_id IS NULL AND status = 'planned' AND date(starts_at) BETWEEN ? AND ?",
                [today_iso(), add_days(today_iso(), 14)]);
        }
        if (role_can($role, 'compliance.read')) {
            $dash = expiring_compliance($db, 60);
            $out['compliance'] = $dash;
            $out['licencesExpiring'] = count($dash['licencesExpiring']);
            $out['rtwExpiring'] = count($dash['rightToWorkExpiring']);
            $out['screeningIncomplete'] = count($dash['screeningIncomplete']);
            $out['awrApproaching'] = count(array_filter($dash['awrApproaching'], fn($a) => !$a['qualified']));
            $out['awrQualified'] = count(array_filter($dash['awrApproaching'], fn($a) => $a['qualified']));
        }
        if (role_can($role, 'purchases.read')) {
            $out['queriedPurchases'] = (int) scalar($db, "SELECT COUNT(*) FROM purchase_invoices WHERE status = 'queried'");
            $out['disputedSelfBills'] = (int) scalar($db, "SELECT COUNT(*) FROM self_bills WHERE status = 'disputed'");
        }
        if (role_can($role, 'statutory.read')) {
            $out['filings'] = array_slice(upcoming_filings($db, today_iso(), 90), 0, 5);
            $out['intermediary'] = array_slice(array_values(array_filter(
                intermediary_obligations($db), fn($i) => $i['status'] === 'due')), 0, 2);
            $out['vatThreshold'] = vat_threshold_status($db);
        }
        return $out;
    });

    return $ops;
}

/**
 * Invokes one operation with authorisation, transaction wrapping and PII
 * masking. $ctx carries dataDir and anything else router-level.
 */
function rpc_invoke(PDO $db, array $user, string $channel, array $payload, array $ctx = []): mixed {
    $ops = rpc_registry();
    if (!isset($ops[$channel])) throw new DomainException("Unknown operation: $channel");
    $opDef = $ops[$channel];

    if ($opDef['capability'] !== 'authenticated' && !role_can($user['role'], $opDef['capability'])) {
        throw new AuthorisationError("Your role ({$user['role']}) does not have permission to do this.");
    }

    $run = fn() => ($opDef['fn'])($db, $user, $payload, $ctx);
    $result = $opDef['readOnly'] ? $run() : in_txn($db, $run);

    return $opDef['maskPii'] ? mask_worker_pii($result, role_can($user['role'], 'workers.pii')) : $result;
}
