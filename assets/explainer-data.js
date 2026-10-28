/*
 * The real testnet-01 run (docs/TESTNET.md) as the explainer on the landing page shows it.
 * tests/explainer.test.ts holds every figure here to fixtures/testnet-01.
 */
export const RUN = {
  date: '2026-10-28',
  rule: 'uniform',
  units: 3,
  reserve: '0.10',
  minBid: '0.05',
  price: '0.11',
  refundTx: '7803d3fcd33325102279420f6382d364f10c485409b4d5a5d41c88188cf1a677',
  refundOutputs: 5,
  checks: 14,
};

/* One row per shielded bid, in the order the page draws them. */
export const BIDS = [
  { tag: 'A', zec: '0.14', outcome: 'winner', txid: '767f4167bb2405736b080ac4f715af44b04562617336e852e0af71ce41aed2d9' },
  { tag: 'B', zec: '0.12', outcome: 'winner', txid: 'd17db195c92ff7e161d03bf8bcf60d1d16b6529b9ed3769e93fa8d4616d4a14f' },
  { tag: 'C', zec: '0.11', outcome: 'winner', txid: '0a008bf0c921fa13b68299983bec48d1a998a3354f3ec1f20eca0cd2e4a1e2af' },
  { tag: 'D', zec: '0.10', outcome: 'refunded', txid: '41095e4d9a680f20aa73c4ba034550057ccbb1cd7132470fa7610efaed9d6021' },
  { tag: 'E', zec: '0.04', outcome: 'dust', txid: '81e9a64227e3269ec326483ca411ca53e19dfe80a477c98d9fc76cf27cc73765' },
  { tag: 'F', zec: '0.13', outcome: 'late', txid: '395127833d38d27956fdd316c9d27633ffb4a72ff032e00daf7821f17bf648da' },
];
