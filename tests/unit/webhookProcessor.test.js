import { jest } from '@jest/globals';
import { claimEventsToProcess } from '../../src/services/webhookProcessor.js';

describe('webhookProcessor claimEventsToProcess', () => {
  it('claims waiting events and marks them as inprocess', async () => {
    const event1 = { _id: 'evt-1' };
    const event2 = { _id: 'evt-2' };
    const lean = jest.fn()
      .mockResolvedValueOnce(event1)
      .mockResolvedValueOnce(event2)
      .mockResolvedValueOnce(null);
    const findOneAndUpdate = jest.fn(() => ({ lean }));

    const result = await claimEventsToProcess({ findOneAndUpdate }, 10);

    expect(result).toEqual([event1, event2]);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(3);
    expect(findOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      { status: 'waiting' },
      { $set: { status: 'inprocess' } },
      { sort: { createdAt: 1, _id: 1 }, new: true }
    );
  });

  it('returns empty array when there are no waiting events', async () => {
    const findOneAndUpdate = jest.fn(() => ({
      lean: jest.fn().mockResolvedValue(null),
    }));

    const result = await claimEventsToProcess({ findOneAndUpdate }, 10);

    expect(result).toEqual([]);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
