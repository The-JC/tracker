// Firebase writes only resolve once the server acknowledged them, i.e. never while offline (the SDK applies them locally
// and queues them). Awaiting such a promise would freeze a button forever, so after `ms` we treat a still-pending write as
// "queued" and carry on. Real rejections (permission denied, ...) still propagate.
export function settle(promise, ms = 4000) {
  let timer;
  const queued = new Promise(resolve => { timer = setTimeout(() => resolve('queued'), ms); });
  return Promise.race([promise, queued]).finally(() => clearTimeout(timer));
}
