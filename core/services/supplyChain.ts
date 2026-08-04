import type { Db } from '../db/connection.js';
import { newId } from '../db/connection.js';
import { recordAudit } from '../db/audit.js';
import { nowInstant, today, addMonths } from '../../shared/dates.js';
import type { IsoDate } from '../../shared/dates.js';

/**
 * The supply chain map.
 *
 * Cerviz supplies staff as a sub-contractor into other agencies, which places it
 * inside a labour supply chain — the most heavily enforced structure in UK tax.
 * The chain for each assignment is recorded explicitly, because two separate
 * things depend on it:
 *
 *   1. It is the first document HMRC asks a labour supplier to produce.
 *   2. It determines where PAYE responsibility for umbrella workers falls.
 *
 * On the second point: since April 2026 responsibility for PAYE on umbrella
 * company workers sits with the recruitment agency that contracts with the end
 * client. Where Cerviz holds that relationship, the risk is Cerviz's. Where
 * Cerviz sits below another agency that holds it, it is theirs. That varies
 * contract by contract, which is exactly why it is derived per assignment rather
 * than assumed once.
 *
 * The derivation below is a decision aid, not advice. Contracts differ, and the
 * app says so in the output rather than pretending to certainty.
 */

export type ChainRole = 'end_client' | 'upper_agency' | 'cerviz' | 'umbrella' | 'worker' | 'other';

export interface ChainLinkInput {
  role: ChainRole;
  organisationId?: string | null;
  description?: string;
  contractRef?: string;
  notes?: string;
}

export function setSupplyChain(db: Db, assignmentId: string, links: ChainLinkInput[]): void {
  const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignmentId) as any;
  if (!assignment) throw new Error('Assignment not found');

  if (!links.some((l) => l.role === 'cerviz')) {
    throw new Error('The supply chain must include Cerviz — the map is incomplete without our own position.');
  }
  if (!links.some((l) => l.role === 'end_client')) {
    throw new Error(
      'The supply chain must identify the end client — the party whose site the officers actually work on. ' +
        'Without it, PAYE responsibility cannot be determined.',
    );
  }

  const before = db
    .prepare('SELECT * FROM supply_chain_links WHERE assignment_id = ? ORDER BY position')
    .all(assignmentId);

  db.prepare('DELETE FROM supply_chain_links WHERE assignment_id = ?').run(assignmentId);

  const insert = db.prepare(
    `INSERT INTO supply_chain_links
       (id, assignment_id, position, role, organisation_id, description, contract_ref, notes, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const now = nowInstant();
  links.forEach((link, i) => {
    insert.run(
      newId('scl'),
      assignmentId,
      i,
      link.role,
      link.organisationId ?? null,
      link.description ?? null,
      link.contractRef ?? null,
      link.notes ?? null,
      now,
    );
  });

  recordAudit(db, {
    entityType: 'assignment',
    entityId: assignmentId,
    action: 'supply_chain_updated',
    summary: `Supply chain map set: ${links.map((l) => l.role).join(' → ')}`,
    before,
    after: links,
  });
}

export interface PayeResponsibility {
  assignmentId: string;
  cervizPosition: number;
  cervizContractsWithEndClient: boolean;
  hasUmbrellaWorkers: boolean;
  responsibility: 'cerviz' | 'upper_agency' | 'not_applicable' | 'unclear';
  confidence: 'clear' | 'check_contract';
  summary: string;
  detail: string;
  actions: string[];
}

export function derivePayeResponsibility(db: Db, assignmentId: string): PayeResponsibility {
  const links = db
    .prepare('SELECT * FROM supply_chain_links WHERE assignment_id = ? ORDER BY position')
    .all(assignmentId) as any[];

  const cerviz = links.find((l) => l.role === 'cerviz');
  const endClient = links.find((l) => l.role === 'end_client');
  const upperAgencies = links.filter((l) => l.role === 'upper_agency');

  // Are any workers on this assignment paid through an umbrella?
  const umbrellaCount = (db
    .prepare(
      `SELECT COUNT(DISTINCT s.worker_id) AS n
       FROM shifts s JOIN workers w ON w.id = s.worker_id
       WHERE s.assignment_id = ? AND w.engagement_type = 'umbrella'`,
    )
    .get(assignmentId) as any).n as number;

  const hasUmbrella = umbrellaCount > 0;

  if (!cerviz || !endClient) {
    return {
      assignmentId,
      cervizPosition: cerviz?.position ?? -1,
      cervizContractsWithEndClient: false,
      hasUmbrellaWorkers: hasUmbrella,
      responsibility: 'unclear',
      confidence: 'check_contract',
      summary: 'Supply chain incomplete',
      detail: 'The chain does not identify both Cerviz and the end client, so responsibility cannot be derived.',
      actions: ['Complete the supply chain map for this assignment.'],
    };
  }

  // Cerviz contracts directly with the end client when nothing sits between them.
  const contractsDirectly = !upperAgencies.some((a) => a.position > endClient.position && a.position < cerviz.position);

  if (!hasUmbrella) {
    return {
      assignmentId,
      cervizPosition: cerviz.position,
      cervizContractsWithEndClient: contractsDirectly,
      hasUmbrellaWorkers: false,
      responsibility: 'not_applicable',
      confidence: 'clear',
      summary: 'No umbrella workers on this assignment',
      detail:
        'The umbrella PAYE rules do not bite here because no worker on this assignment is paid through ' +
        'an umbrella company. Normal PAYE or off-payroll rules still apply to however the workers are engaged.',
      actions: [],
    };
  }

  if (contractsDirectly) {
    return {
      assignmentId,
      cervizPosition: cerviz.position,
      cervizContractsWithEndClient: true,
      hasUmbrellaWorkers: true,
      responsibility: 'cerviz',
      confidence: 'check_contract',
      summary: 'PAYE responsibility likely sits with Cerviz',
      detail:
        `Cerviz contracts directly with the end client (${endClient.description ?? 'end client'}) and ` +
        `${umbrellaCount} worker(s) on this assignment are paid through an umbrella. Since April 2026, ` +
        'responsibility for accounting for PAYE on umbrella workers sits with the agency that contracts ' +
        'with the end client — which on this assignment appears to be Cerviz.',
      actions: [
        'Confirm this reading against the actual contract with your accountant.',
        'Keep the umbrella’s pay-chain evidence for every worker on this assignment.',
        'Satisfy yourself that the umbrella is operating PAYE correctly — the liability may land on you.',
      ],
    };
  }

  const upper = upperAgencies[0];
  return {
    assignmentId,
    cervizPosition: cerviz.position,
    cervizContractsWithEndClient: false,
    hasUmbrellaWorkers: true,
    responsibility: 'upper_agency',
    confidence: 'check_contract',
    summary: 'PAYE responsibility likely sits with the agency above Cerviz',
    detail:
      `${upper?.description ?? 'An agency above Cerviz'} holds the end-client relationship on this assignment, ` +
      'so responsibility for umbrella PAYE most likely sits with them rather than Cerviz. This does not ' +
      'remove Cerviz from the chain: HMRC can still look down the chain where the responsible party fails, ' +
      'and supply chain due diligence remains Cerviz’s own obligation.',
    actions: [
      'Confirm in writing with the agency above that they are accounting for umbrella PAYE.',
      'Keep due diligence records for that agency current.',
      'Retain the umbrella’s details and pay-chain evidence regardless.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Counterparty due diligence
// ---------------------------------------------------------------------------

export const REQUIRED_CHECKS = [
  'companies_house',
  'vat_number',
  'insurance',
  'contract',
] as const;

export const CHECK_LABELS: Record<string, string> = {
  companies_house: 'Companies House registration verified',
  vat_number: 'VAT number verified',
  insurance: 'Employer’s and public liability insurance seen',
  contract: 'Signed contract or terms of business on file',
  credit: 'Credit check',
  licence: 'Licence or accreditation verified',
  site_visit: 'Site visit carried out',
  other: 'Other check',
};

export function recordDueDiligence(
  db: Db,
  input: {
    organisationId: string;
    checkType: string;
    performedOn?: IsoDate;
    performedBy?: string;
    outcome: 'pass' | 'fail' | 'query' | 'not_applicable';
    reference?: string;
    notes?: string;
    reviewMonths?: number;
  },
): string {
  const id = newId('dd');
  const performedOn = input.performedOn ?? today();

  db.prepare(
    `INSERT INTO org_due_diligence
       (id, organisation_id, check_type, performed_on, performed_by, outcome, reference, notes, next_review_on, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.organisationId,
    input.checkType,
    performedOn,
    input.performedBy ?? process.env.USER ?? 'operator',
    input.outcome,
    input.reference ?? null,
    input.notes ?? null,
    addMonths(performedOn, input.reviewMonths ?? 12),
    nowInstant(),
  );

  recordAudit(db, {
    entityType: 'organisation',
    entityId: input.organisationId,
    action: 'due_diligence_recorded',
    summary: `${CHECK_LABELS[input.checkType] ?? input.checkType}: ${input.outcome}`,
    after: input,
  });

  return id;
}

export interface DueDiligenceStatus {
  organisationId: string;
  name: string;
  complete: boolean;
  missing: string[];
  failed: string[];
  overdue: string[];
  checks: any[];
  riskNote: string;
}

/**
 * Whether a counterparty has been checked properly. Under the Kittel principle
 * HMRC can deny VAT recovery and pursue a business for fraud elsewhere in its
 * chain where it "knew or should have known". Documented checks are the defence.
 */
export function dueDiligenceStatus(db: Db, organisationId: string): DueDiligenceStatus {
  const org = db.prepare('SELECT * FROM organisations WHERE id = ?').get(organisationId) as any;
  if (!org) throw new Error('Organisation not found');

  const checks = db
    .prepare('SELECT * FROM org_due_diligence WHERE organisation_id = ? ORDER BY performed_on DESC')
    .all(organisationId) as any[];

  const latestByType = new Map<string, any>();
  for (const c of checks) if (!latestByType.has(c.check_type)) latestByType.set(c.check_type, c);

  const missing = REQUIRED_CHECKS.filter((t) => !latestByType.has(t)).map((t) => CHECK_LABELS[t]);
  const failed = [...latestByType.values()].filter((c) => c.outcome === 'fail').map((c) => CHECK_LABELS[c.check_type] ?? c.check_type);
  const now = today();
  const overdue = [...latestByType.values()]
    .filter((c) => c.next_review_on && c.next_review_on < now)
    .map((c) => `${CHECK_LABELS[c.check_type] ?? c.check_type} (due ${c.next_review_on})`);

  const complete = missing.length === 0 && failed.length === 0;

  let riskNote: string;
  if (failed.length > 0) {
    riskNote =
      'A due diligence check has FAILED for this counterparty. Do not place workers or accept work ' +
      'until it is resolved and the resolution is documented.';
  } else if (missing.length > 0) {
    riskNote =
      `${missing.length} required check(s) have never been carried out. If this counterparty turns out to ` +
      'be connected to fraud, undocumented checks are what turns someone else’s problem into yours.';
  } else if (overdue.length > 0) {
    riskNote = `${overdue.length} check(s) are past their review date. Refresh them.`;
  } else {
    riskNote = 'Due diligence is complete and current for this counterparty.';
  }

  return {
    organisationId,
    name: org.name,
    complete,
    missing,
    failed,
    overdue,
    checks,
    riskNote,
  };
}

export function supplyChainFor(db: Db, assignmentId: string) {
  const links = db
    .prepare(
      `SELECT l.*, o.name AS organisation_name, o.company_number, o.vat_number
       FROM supply_chain_links l
       LEFT JOIN organisations o ON o.id = l.organisation_id
       WHERE l.assignment_id = ? ORDER BY l.position`,
    )
    .all(assignmentId) as any[];

  return {
    links: links.map((l) => ({
      ...l,
      dueDiligence: l.organisation_id ? dueDiligenceStatus(db, l.organisation_id) : null,
    })),
    payeResponsibility: derivePayeResponsibility(db, assignmentId),
  };
}
