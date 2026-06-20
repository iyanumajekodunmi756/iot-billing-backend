/**
 * k6 steady-state profile.
 *
 * Mirrors issue #20's "sustain 50k payloads/sec for 5 minutes" target.
 * Defaults to 50,000 VUs (one per device) producing one payload/sec
 * each, for 300 seconds. Cut down with environment variables for
 * CI / dev runs.
 *
 *   VIRTUAL_USERS    default 50000
 *   DURATION_SECONDS default 300
 *   TARGET_URL       default http://localhost:4000
 */

import http from 'k6/http';
import { check } from 'k6';
import { generateDevice, generatePayload, encodeBody, defaultOptions } from './common.js';

const VIRTUAL_USERS = Number(__ENV.VIRTUAL_USERS ?? 50000);
const DURATION_SECONDS = Number(__ENV.DURATION_SECONDS ?? 300);
const TARGET_URL = __ENV.TARGET_URL ?? 'http://localhost:4000';

export const options = {
  scenarios: {
    steady_state: {
      executor: 'constant-arrival-rate',
      rate: VIRTUAL_USERS, // 50k per second
      timeUnit: '1s',
      duration: `${DURATION_SECONDS.toString()}s`,
      preAllocatedVUs: Math.min(VIRTUAL_USERS, 2000),
      maxVUs: VIRTUAL_USERS,
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
    tags: { fault: fault ?? 'none', device: device.deviceId },
  });
  check(res, {
    'status is 200 or 202': (r) => r.status === 200 || r.status === 202,
    'status below 500': (r) => r.status < 500,
  });
}
