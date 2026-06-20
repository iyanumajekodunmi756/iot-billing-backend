/**
 * k6 burst profile.
 *
 * Mirrors issue #20's "burst" workload: a sharp ramp to the
 * upper-bound throughput, held briefly, then ramped back down to
 * baseline. Exercises connection-pool churn, nonce-cache pressure,
 * and any GC pauses caused by 50k concurrent VUs.
 *
 *   VIRTUAL_USERS    default 50000
 *   PEAK_HOLD_SECONDS default 60
 *   RAMP_SECONDS     default 30
 *   TARGET_URL       default http://localhost:4000
 */

import http from 'k6/http';
import { check } from 'k6';
import { generateDevice, generatePayload, encodeBody, defaultOptions } from './common.js';

const VIRTUAL_USERS = Number(__ENV.VIRTUAL_USERS ?? 50000);
const RAMP_SECONDS = Number(__ENV.RAMP_SECONDS ?? 30);
const PEAK_HOLD_SECONDS = Number(__ENV.PEAK_HOLD_SECONDS ?? 60);
const TARGET_URL = __ENV.TARGET_URL ?? 'http://localhost:4000';

export const options = {
  scenarios: {
    burst: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: `${RAMP_SECONDS.toString()}s`, target: VIRTUAL_USERS },
        { duration: `${PEAK_HOLD_SECONDS.toString()}s`, target: VIRTUAL_USERS },
        { duration: `${RAMP_SECONDS.toString()}s`, target: 0 },
      ],
      gracefulRampDown: `${RAMP_SECONDS.toString()}s`,
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<500'],
    http_req_failed: ['rate<0.10'], // Bursts typically carry a few more 5xx
  },
  discardResponseBodies: true,
  ...defaultOptions(),
};

export default function () {
  const device = generateDevice(__VU);
  const { payload, fault } = generatePayload(device);
  const body = encodeBody(device, payload);
  const res = http.post(`${TARGET_URL}/ingest`, body, {
    tags: { fault: fault ?? 'none' },
  });
  check(res, {
    'status below 500': (r) => r.status < 500,
  });
}
