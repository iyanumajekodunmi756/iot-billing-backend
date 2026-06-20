/**
 * k6 recovery profile.
 *
 * After a burst, the system must purge nonces from the sliding-window
 * cache and any ledger-sync backlog from the synchronizer. This
 * profile cycles between idle and peak to verify graceful recovery.
 *
 *   VIRTUAL_USERS    default 50000
 *   CYCLES           default 2
 *   RAMP_SECONDS     default 30
 *   HOLD_SECONDS     default 30
 *   IDLE_SECONDS     default 60
 *   TARGET_URL       default http://localhost:4000
 */

import http from 'k6/http';
import { check } from 'k6';
import { generateDevice, generatePayload, encodeBody, defaultOptions } from './common.js';

const VIRTUAL_USERS = Number(__ENV.VIRTUAL_USERS ?? 50000);
const CYCLES = Number(__ENV.CYCLES ?? 2);
const RAMP_SECONDS = Number(__ENV.RAMP_SECONDS ?? 30);
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS ?? 30);
const IDLE_SECONDS = Number(__ENV.IDLE_SECONDS ?? 60);
const TARGET_URL = __ENV.TARGET_URL ?? 'http://localhost:4000';

const stages = [];
for (let i = 0; i < CYCLES; i++) {
  stages.push({ duration: `${RAMP_SECONDS.toString()}s`, target: VIRTUAL_USERS });
  stages.push({ duration: `${HOLD_SECONDS.toString()}s`, target: VIRTUAL_USERS });
  stages.push({ duration: `${RAMP_SECONDS.toString()}s`, target: 0 });
  stages.push({ duration: `${IDLE_SECONDS.toString()}s`, target: 0 });
}

export const options = {
  scenarios: {
    recovery: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages,
      gracefulRampDown: `${RAMP_SECONDS.toString()}s`,
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<500'],
    http_req_failed: ['rate<0.05'],
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
