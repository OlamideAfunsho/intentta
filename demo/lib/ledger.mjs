// Minimal client for the Canton JSON Ledger API v2. No dependencies.
//
// Every call names the parties it acts or reads as, so each function below
// is an explicitly party-scoped view of the ledger. On the local sandbox no
// token is needed. On a secured participant, set LEDGER_TOKEN in the
// environment; it is sent as a bearer token and never written anywhere.

import { randomUUID } from 'node:crypto';

export class LedgerError extends Error {
  constructor(status, body) {
    const cause = body?.cause || body?.message || JSON.stringify(body);
    super(`${body?.code || status}: ${cause}`);
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}

export class Ledger {
  constructor({ baseUrl = process.env.LEDGER_URL || 'http://localhost:7575', userId, token } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    // On a participant with authentication, the user the token belongs to.
    this.userId = process.env.LEDGER_USER || userId || 'intentta-demo';
    // A token string, or a function returning one, for this participant.
    this.token = token;
  }

  async call(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    const token = typeof this.token === 'function' ? this.token() : this.token || process.env.LEDGER_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { message: text }; }
    if (!res.ok) throw new LedgerError(res.status, json);
    return json;
  }

  async ledgerEnd() {
    return (await this.call('GET', '/v2/state/ledger-end')).offset;
  }

  // Event format selecting everything `parties` are entitled to see.
  static wildcard(parties, { blobs = false } = {}) {
    const filtersByParty = {};
    for (const p of parties) {
      filtersByParty[p] = {
        cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: blobs } } } }],
      };
    }
    return { filtersByParty, verbose: true };
  }

  static byTemplate(parties, templateIds, { blobs = false } = {}) {
    const filtersByParty = {};
    for (const p of parties) {
      filtersByParty[p] = {
        cumulative: templateIds.map((templateId) => ({
          identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: blobs } } },
        })),
      };
    }
    return { filtersByParty, verbose: true };
  }

  static byInterface(parties, interfaceId, { blobs = false } = {}) {
    const filtersByParty = {};
    for (const p of parties) {
      filtersByParty[p] = {
        cumulative: [{
          identifierFilter: {
            InterfaceFilter: { value: { interfaceId, includeInterfaceView: true, includeCreatedEventBlob: blobs } },
          },
        }],
      };
    }
    return { filtersByParty, verbose: true };
  }

  // Active contracts visible to the parties named in `eventFormat`.
  async activeContracts(eventFormat) {
    const activeAtOffset = await this.ledgerEnd();
    const rows = await this.call('POST', '/v2/state/active-contracts', {
      eventFormat,
      activeAtOffset,
    });
    return rows
      .map((r) => r.contractEntry?.JsActiveContract)
      .filter(Boolean)
      .map((c) => ({
        contractId: c.createdEvent.contractId,
        templateId: c.createdEvent.templateId,
        payload: c.createdEvent.createArgument,
        interfaceViews: c.createdEvent.interfaceViews || [],
        signatories: c.createdEvent.signatories,
        observers: c.createdEvent.observers,
        createdAt: c.createdEvent.createdAt,
        blob: c.createdEvent.createdEventBlob,
        synchronizerId: c.synchronizerId,
      }));
  }

  // Contracts of the given templates that `party` is a stakeholder of.
  query(party, templateIds, opts) {
    const ids = Array.isArray(templateIds) ? templateIds : [templateIds];
    return this.activeContracts(Ledger.byTemplate([party], ids, opts));
  }

  // Disclosure records for the given contract ids, read as `reader`.
  async disclosures(reader, contractIds) {
    const wanted = new Set(contractIds);
    const all = await this.activeContracts(Ledger.wildcard([reader], { blobs: true }));
    const found = all.filter((c) => wanted.has(c.contractId));
    const missing = [...wanted].filter((id) => !found.some((c) => c.contractId === id));
    return {
      disclosed: found.map((c) => ({
        templateId: c.templateId,
        contractId: c.contractId,
        createdEventBlob: c.blob,
        synchronizerId: c.synchronizerId,
      })),
      missing,
    };
  }

  // Submit commands and return the resulting transaction as seen by `actAs`.
  async submit({ actAs, readAs = [], commands, disclosed = [], commandId = randomUUID() }) {
    const act = Array.isArray(actAs) ? actAs : [actAs];
    const res = await this.call('POST', '/v2/commands/submit-and-wait-for-transaction', {
      commands: {
        commandId,
        userId: this.userId,
        actAs: act,
        readAs,
        commands,
        disclosedContracts: disclosed,
      },
      transactionFormat: {
        eventFormat: Ledger.wildcard([...act, ...readAs]),
        transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
      },
    });
    return summarize(res.transaction);
  }

  create(actAs, templateId, createArguments, extra = {}) {
    return this.submit({ actAs, commands: [{ CreateCommand: { templateId, createArguments } }], ...extra });
  }

  exercise(actAs, templateId, contractId, choice, choiceArgument, extra = {}) {
    return this.submit({
      actAs,
      commands: [{ ExerciseCommand: { templateId, contractId, choice, choiceArgument } }],
      ...extra,
    });
  }

  // The update stream as seen by `parties` between two offsets: the
  // transaction history those parties are entitled to.
  async updates(parties, beginExclusive, endInclusive) {
    let rows;
    try {
      rows = await this.call('POST', '/v2/updates/flats', {
        beginExclusive,
        endInclusive,
        updateFormat: {
          includeTransactions: {
            eventFormat: Ledger.wildcard(parties),
            transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
          },
        },
      });
    } catch (e) {
      // The JSON API caps list responses. Split the offset range and retry.
      if (e.code !== 'JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED' || endInclusive - beginExclusive < 2) throw e;
      const mid = Math.floor((beginExclusive + endInclusive) / 2);
      return [
        ...(await this.updates(parties, beginExclusive, mid)),
        ...(await this.updates(parties, mid, endInclusive)),
      ];
    }
    return rows
      .map((r) => r.update?.Transaction?.value)
      .filter(Boolean)
      .map(summarize);
  }
}

// Reduce a transaction to what the evidence and the UI need.
export function summarize(tx) {
  const events = (tx.events || []).map((e) => {
    if (e.CreatedEvent) {
      const c = e.CreatedEvent;
      return { kind: 'created', templateId: c.templateId, contractId: c.contractId, payload: c.createArgument };
    }
    if (e.ExercisedEvent) {
      const x = e.ExercisedEvent;
      return {
        kind: 'exercised',
        templateId: x.templateId,
        interfaceId: x.interfaceId,
        contractId: x.contractId,
        choice: x.choice,
        consuming: x.consuming,
        actingParties: x.actingParties,
        result: x.exerciseResult,
      };
    }
    if (e.ArchivedEvent) {
      const a = e.ArchivedEvent;
      return { kind: 'archived', templateId: a.templateId, contractId: a.contractId };
    }
    return { kind: 'unknown' };
  });
  return {
    updateId: tx.updateId,
    offset: tx.offset,
    effectiveAt: tx.effectiveAt,
    recordTime: tx.recordTime,
    synchronizerId: tx.synchronizerId,
    commandId: tx.commandId,
    events,
  };
}

// `Module:Entity` of a template id, whatever the package reference form.
export function entity(templateId) {
  return templateId.split(':').slice(1).join(':');
}

export function created(tx, entityName) {
  return tx.events.filter((e) => e.kind === 'created' && entity(e.templateId) === entityName);
}

export function exercised(tx, choice) {
  return tx.events.filter((e) => e.kind === 'exercised' && e.choice === choice);
}
