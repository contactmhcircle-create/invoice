<?php
/**
 * Tamper-evident audit log — port of core/db/audit.ts.
 *
 * Each entry's hash covers its own content plus the previous entry's hash, with
 * a unit separator between fields so content containing delimiters cannot be
 * crafted to collide with a different field layout. The table's triggers
 * (in the shared migration SQL) refuse UPDATE and DELETE; the chain covers the
 * case where someone edits the database file directly.
 */

declare(strict_types=1);

const AUDIT_GENESIS = '0000000000000000000000000000000000000000000000000000000000000000';
const AUDIT_SEP = "\x1f";

function audit_hash(array $f): string {
    $payload = implode(AUDIT_SEP, [
        $f['at'], $f['actor'], $f['entityType'], $f['entityId'], $f['action'],
        $f['summary'], $f['beforeJson'], $f['afterJson'], $f['prevHash'],
    ]);
    return hash('sha256', $payload);
}

/**
 * Append an entry. $entry keys: entityType, entityId, action, and optionally
 * summary, before, after, actor. Call inside the same transaction as the change.
 */
function record_audit(PDO $db, array $entry): void {
    $prev = row($db, 'SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');

    $f = [
        'at' => now_instant(),
        'actor' => $entry['actor'] ?? 'system',
        'entityType' => $entry['entityType'],
        'entityId' => (string) $entry['entityId'],
        'action' => $entry['action'],
        'summary' => $entry['summary'] ?? '',
        'beforeJson' => array_key_exists('before', $entry) && $entry['before'] !== null
            ? json_encode($entry['before'], JSON_UNESCAPED_UNICODE) : '',
        'afterJson' => array_key_exists('after', $entry) && $entry['after'] !== null
            ? json_encode($entry['after'], JSON_UNESCAPED_UNICODE) : '',
        'prevHash' => $prev['hash'] ?? AUDIT_GENESIS,
    ];

    q($db, 'INSERT INTO audit_log
              (at, actor, entity_type, entity_id, action, summary, before_json, after_json, prev_hash, hash)
            VALUES (?,?,?,?,?,?,?,?,?,?)',
        [$f['at'], $f['actor'], $f['entityType'], $f['entityId'], $f['action'],
         $f['summary'], $f['beforeJson'], $f['afterJson'], $f['prevHash'], audit_hash($f)]);
}

/** Walks the whole chain; reports the first break. */
function verify_audit_chain(PDO $db): array {
    $expectedPrev = AUDIT_GENESIS;
    $checked = 0;

    $stmt = q($db, 'SELECT id, at, actor, entity_type, entity_id, action, summary,
                           before_json, after_json, prev_hash, hash
                    FROM audit_log ORDER BY id ASC');

    while ($r = $stmt->fetch(PDO::FETCH_ASSOC)) {
        if ($r['prev_hash'] !== $expectedPrev) {
            return ['ok' => false, 'entriesChecked' => $checked, 'brokenAtId' => (int) $r['id'],
                'reason' => "Entry {$r['id']} does not follow the previous entry — a record may have been removed."];
        }
        $recomputed = audit_hash([
            'at' => $r['at'], 'actor' => $r['actor'], 'entityType' => $r['entity_type'],
            'entityId' => $r['entity_id'], 'action' => $r['action'],
            'summary' => $r['summary'] ?? '', 'beforeJson' => $r['before_json'] ?? '',
            'afterJson' => $r['after_json'] ?? '', 'prevHash' => $r['prev_hash'],
        ]);
        if ($recomputed !== $r['hash']) {
            return ['ok' => false, 'entriesChecked' => $checked, 'brokenAtId' => (int) $r['id'],
                'reason' => "Entry {$r['id']} has been altered since it was written."];
        }
        $expectedPrev = $r['hash'];
        $checked++;
    }

    return ['ok' => true, 'entriesChecked' => $checked];
}

function audit_trail_for(PDO $db, string $entityType, string $entityId): array {
    return rows($db, 'SELECT id, at, actor, action, summary, before_json, after_json
                      FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY id ASC',
        [$entityType, $entityId]);
}
