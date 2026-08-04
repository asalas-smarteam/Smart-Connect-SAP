import {
  DUPLICATE_CONTACT_EMAIL_REPORT,
  buildDuplicateContactEmailReport,
} from '../../../src/application/services/duplicateContactEmail.report.js';

function entry(sapContactId, sapCompanyId, properties = {}) {
  return {
    sapInternalCode: sapContactId,
    company: { sapCompanyId, hubspotId: `hs-co-${sapCompanyId}` },
    contactPayload: { properties },
  };
}

function collisions(groups) {
  return new Map(groups.map((group) => [`${group.property}:${group.value}`, group]));
}

describe('buildDuplicateContactEmailReport', () => {
  it('returns null when nothing collided', () => {
    expect(buildDuplicateContactEmailReport({ collisions: new Map() })).toBeNull();
  });

  it('groups every contact sharing a value into one entry', () => {
    const report = buildDuplicateContactEmailReport({
      collisions: collisions([{
        property: 'email',
        value: 'george@x.com',
        entries: [
          entry(104149, '104188', { firstname: 'George', lastname: 'Martínez', phone: '8095486353' }),
          entry(103669, '103717', { firstname: 'George', lastname: 'Martínez' }),
        ],
      }]),
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
      generatedAt: '2026-08-03T18:08:03.044Z',
    });

    expect(report.eventType).toBe(DUPLICATE_CONTACT_EMAIL_REPORT);
    expect(report.payload).toMatchObject({
      reportType: DUPLICATE_CONTACT_EMAIL_REPORT,
      generatedAt: '2026-08-03T18:08:03.044Z',
      clientConfigId: 'cfg-1',
      syncLogId: 'log-1',
      objectType: 'contact',
      summary: { duplicatedValues: 1, affectedContacts: 2, properties: ['email'] },
    });
    expect(report.payload.duplicates).toEqual([{
      property: 'email',
      value: 'george@x.com',
      contactCount: 2,
      contacts: [
        {
          sapContactId: 104149,
          sapCompanyId: '104188',
          hubspotCompanyId: 'hs-co-104188',
          firstname: 'George',
          lastname: 'Martínez',
          phone: '8095486353',
        },
        {
          sapContactId: 103669,
          sapCompanyId: '103717',
          hubspotCompanyId: 'hs-co-103717',
          firstname: 'George',
          lastname: 'Martínez',
          phone: null,
        },
      ],
    }]);
  });

  it('orders the worst offenders first', () => {
    const report = buildDuplicateContactEmailReport({
      collisions: collisions([
        { property: 'email', value: 'two@x.com', entries: [entry(1, 'a'), entry(2, 'b')] },
        { property: 'email', value: 'three@x.com', entries: [entry(3, 'c'), entry(4, 'd'), entry(5, 'e')] },
      ]),
    });

    expect(report.payload.duplicates.map(({ value }) => value)).toEqual(['three@x.com', 'two@x.com']);
    expect(report.payload.summary).toMatchObject({ duplicatedValues: 2, affectedContacts: 5 });
  });

  it('drops groups that ended up with a single contact', () => {
    // A collision recorded and then resolved (the twin was deduped away) is not
    // a data problem: reporting it would send the data team chasing nothing.
    const report = buildDuplicateContactEmailReport({
      collisions: collisions([{ property: 'email', value: 'solo@x.com', entries: [entry(1, 'a')] }]),
    });

    expect(report).toBeNull();
  });
});
