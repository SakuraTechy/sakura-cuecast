const DEFAULT_SNAPSHOT_LIMIT_BYTES = 5 * 1024 * 1024;

function errorMessage(error) {
  return String(error?.message || error || '未知错误');
}

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
  } catch {
    return '';
  }
}

function normalizeCookie(cookie) {
  const output = {};
  for (const key of [
    'name',
    'value',
    'url',
    'domain',
    'path',
    'secure',
    'httpOnly',
    'sameSite',
    'expires',
    'priority',
    'sameParty',
    'sourceScheme',
    'sourcePort',
    'partitionKey',
  ]) {
    if (cookie?.[key] !== undefined) output[key] = cookie[key];
  }
  if (cookie?.session === true) delete output.expires;
  return output;
}

function snapshotSize(snapshot) {
  return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
}

/** 在页面 origin 内执行；函数体必须保持自包含，供 chrome.scripting 序列化。 */
async function captureOriginState() {
  const bytesToBase64 = (bytes) => {
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  };
  const seen = new WeakSet();
  const encode = async (value) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return { __ccType: 'number', value: 'NaN' };
      if (value === Infinity) return { __ccType: 'number', value: 'Infinity' };
      if (value === -Infinity) return { __ccType: 'number', value: '-Infinity' };
      return value;
    }
    if (typeof value === 'undefined') return { __ccType: 'undefined' };
    if (typeof value === 'bigint') return { __ccType: 'bigint', value: String(value) };
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new Error(`CDP_AUTH_STATE_UNSUPPORTED: ${typeof value}`);
    }
    if (seen.has(value)) throw new Error('CDP_AUTH_STATE_UNSUPPORTED: circular reference');
    seen.add(value);
    try {
      if (value instanceof Date) return { __ccType: 'date', value: value.toISOString() };
      if (value instanceof RegExp) return { __ccType: 'regexp', source: value.source, flags: value.flags };
      if (value instanceof ArrayBuffer) {
        return { __ccType: 'array-buffer', value: bytesToBase64(new Uint8Array(value)) };
      }
      if (ArrayBuffer.isView(value)) {
        return {
          __ccType: 'typed-array',
          name: value.constructor.name,
          value: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
        };
      }
      if (value instanceof Blob) {
        return {
          __ccType: value instanceof File ? 'file' : 'blob',
          value: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
          mimeType: value.type,
          ...(value instanceof File ? { name: value.name, lastModified: value.lastModified } : {}),
        };
      }
      if (value instanceof Map) {
        const entries = [];
        for (const [key, item] of value.entries()) entries.push([await encode(key), await encode(item)]);
        return { __ccType: 'map', entries };
      }
      if (value instanceof Set) {
        const values = [];
        for (const item of value.values()) values.push(await encode(item));
        return { __ccType: 'set', values };
      }
      if (Array.isArray(value)) {
        const values = [];
        for (const item of value) values.push(await encode(item));
        return values;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`CDP_AUTH_STATE_UNSUPPORTED: ${prototype?.constructor?.name || 'unknown object'}`);
      }
      const output = {};
      for (const [key, item] of Object.entries(value)) output[key] = await encode(item);
      return output;
    } finally {
      seen.delete(value);
    }
  };

  if (typeof indexedDB.databases !== 'function') {
    throw new Error('CDP_AUTH_STATE_UNSUPPORTED: indexedDB.databases unavailable');
  }
  const databases = [];
  for (const descriptor of await indexedDB.databases()) {
    if (!descriptor.name) continue;
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(descriptor.name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const stores = [];
      for (const storeName of database.objectStoreNames) {
        const tx = database.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const indexes = [...store.indexNames].map((name) => {
          const index = store.index(name);
          return {
            name: index.name,
            keyPath: index.keyPath,
            multiEntry: index.multiEntry,
            unique: index.unique,
          };
        });
        const rawRecords = await new Promise((resolve, reject) => {
          const keysRequest = store.getAllKeys();
          const valuesRequest = store.getAll();
          tx.oncomplete = () => resolve(keysRequest.result.map((key, index) => ({
            key,
            value: valuesRequest.result[index],
          })));
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error(`IndexedDB 读取事务中止：${storeName}`));
          keysRequest.onerror = () => reject(keysRequest.error);
          valuesRequest.onerror = () => reject(valuesRequest.error);
        });
        // 事务完成后再序列化 Blob 等异步值，避免等待期间事务失活。
        const records = [];
        for (const record of rawRecords) {
          records.push({
            key: await encode(record.key),
            value: await encode(record.value),
          });
        }
        stores.push({
          name: store.name,
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes,
          records,
        });
      }
      databases.push({ name: database.name, version: database.version, stores });
    } finally {
      database.close();
    }
  }
  return {
    origin: location.origin,
    localStorage: Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
    sessionStorage: Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]),
    indexedDB: databases,
  };
}

/** 在页面 origin 内执行；函数体必须保持自包含，供 chrome.scripting 序列化。 */
async function restoreOriginState(snapshot) {
  const base64ToBytes = (value) => {
    const binary = atob(value || '');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
  const typedArrayConstructors = {
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array: globalThis.BigInt64Array,
    BigUint64Array: globalThis.BigUint64Array,
    DataView,
  };
  const decode = async (value) => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return Promise.all(value.map(decode));
    const type = value.__ccType;
    if (!type) {
      const output = {};
      for (const [key, item] of Object.entries(value)) output[key] = await decode(item);
      return output;
    }
    if (type === 'undefined') return undefined;
    if (type === 'bigint') return BigInt(value.value);
    if (type === 'number') return Number(value.value);
    if (type === 'date') return new Date(value.value);
    if (type === 'regexp') return new RegExp(value.source, value.flags);
    if (type === 'array-buffer') return base64ToBytes(value.value).buffer;
    if (type === 'typed-array') {
      const Constructor = typedArrayConstructors[value.name];
      if (!Constructor) throw new Error(`CDP_AUTH_STATE_UNSUPPORTED: ${value.name}`);
      const bytes = base64ToBytes(value.value);
      return value.name === 'DataView'
        ? new DataView(bytes.buffer)
        : new Constructor(bytes.buffer);
    }
    if (type === 'blob' || type === 'file') {
      const bytes = base64ToBytes(value.value);
      return type === 'file'
        ? new File([bytes], value.name, { type: value.mimeType, lastModified: value.lastModified })
        : new Blob([bytes], { type: value.mimeType });
    }
    if (type === 'map') {
      const entries = [];
      for (const [key, item] of value.entries || []) entries.push([await decode(key), await decode(item)]);
      return new Map(entries);
    }
    if (type === 'set') {
      const values = [];
      for (const item of value.values || []) values.push(await decode(item));
      return new Set(values);
    }
    throw new Error(`CDP_AUTH_STATE_UNSUPPORTED: ${type}`);
  };
  const requestAsPromise = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  localStorage.clear();
  for (const [key, value] of snapshot.localStorage || []) localStorage.setItem(key, value);
  sessionStorage.clear();
  for (const [key, value] of snapshot.sessionStorage || []) sessionStorage.setItem(key, value);

  for (const database of snapshot.indexedDB || []) {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(database.name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`IndexedDB 删除被阻塞：${database.name}`));
    });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(database.name, Math.max(1, Number(database.version) || 1));
      request.onupgradeneeded = () => {
        for (const schema of database.stores || []) {
          const store = request.result.createObjectStore(schema.name, {
            keyPath: schema.keyPath ?? null,
            autoIncrement: schema.autoIncrement === true,
          });
          for (const index of schema.indexes || []) {
            store.createIndex(index.name, index.keyPath, {
              multiEntry: index.multiEntry === true,
              unique: index.unique === true,
            });
          }
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      for (const schema of database.stores || []) {
        const decodedRecords = [];
        for (const record of schema.records || []) {
          decodedRecords.push({
            key: await decode(record.key),
            value: await decode(record.value),
          });
        }
        const tx = db.transaction(schema.name, 'readwrite');
        const store = tx.objectStore(schema.name);
        const transactionDone = new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error(`IndexedDB 恢复中止：${schema.name}`));
        });
        const writes = decodedRecords.map((record) => requestAsPromise(
          schema.keyPath === null || schema.keyPath === undefined
            ? store.put(record.value, record.key)
            : store.put(record.value),
        ));
        await Promise.all(writes);
        await transactionDone;
      }
    } finally {
      db.close();
    }
  }
  return { ok: true };
}

export class CdpAuthStateService {
  constructor(chromeApi = globalThis.chrome, { snapshotLimitBytes = DEFAULT_SNAPSHOT_LIMIT_BYTES } = {}) {
    this.chrome = chromeApi;
    this.snapshotLimitBytes = snapshotLimitBytes;
  }

  async capture({ browserContextId, driver, tabs = [], origins = [], lastUrl = '' }) {
    try {
      const originSet = new Set([
        ...origins.map(normalizeOrigin),
        ...tabs.map((tab) => normalizeOrigin(tab?.url)),
        normalizeOrigin(lastUrl),
      ].filter(Boolean));
      const cookieUrls = [...new Set([
        ...tabs.map((tab) => String(tab?.url || '')),
        String(lastUrl || ''),
        ...originSet,
      ].filter((url) => /^https?:\/\//i.test(url)))];
      const cookieResult = await driver.sendBrowserCommand('Storage.getCookies', {
        browserContextId,
        urls: cookieUrls,
      });
      const originStates = [];
      for (const origin of originSet) {
        originStates.push(await this.captureOrigin(browserContextId, origin, tabs, driver));
      }
      const snapshot = {
        version: 1,
        cookies: (cookieResult?.cookies || []).map(normalizeCookie),
        origins: originStates,
        lastUrl: String(lastUrl || ''),
        capturedAt: Date.now(),
      };
      const size = snapshotSize(snapshot);
      if (size > this.snapshotLimitBytes) {
        throw new Error(`CDP_AUTH_STATE_TOO_LARGE: ${size}/${this.snapshotLimitBytes}`);
      }
      return snapshot;
    } catch (error) {
      const wrapped = new Error(`认证状态捕获失败：${errorMessage(error)}`);
      wrapped.code = String(error?.message || '').includes('TOO_LARGE')
        ? 'CDP_AUTH_STATE_TOO_LARGE'
        : 'CDP_AUTH_STATE_UNSUPPORTED';
      throw wrapped;
    }
  }

  async captureOrigin(browserContextId, origin, tabs, driver) {
    const existing = tabs.find((tab) => normalizeOrigin(tab?.url) === origin);
    let temporaryTargetId = '';
    let tab = existing;
    try {
      if (!tab?.id) {
        const temporary = await driver.createInertOriginTarget(browserContextId, origin);
        temporaryTargetId = temporary.targetId;
        tab = temporary.tab;
      }
      await driver.waitForTabLoad(tab.id);
      const result = await this.chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: captureOriginState,
      });
      if (!result?.[0]?.result) throw new Error(`origin 未返回状态：${origin}`);
      return result[0].result;
    } finally {
      if (temporaryTargetId) await driver.closeTarget(temporaryTargetId);
    }
  }

  async restore({ browserContextId, driver, snapshot, target = null }) {
    if (!snapshot || snapshot.version !== 1) return;
    try {
      if (snapshot.cookies?.length) {
        await driver.sendBrowserCommand('Storage.setCookies', {
          browserContextId,
          cookies: snapshot.cookies.map(normalizeCookie),
        });
      }
      for (const originState of snapshot.origins || []) {
        const origin = normalizeOrigin(originState?.origin);
        if (!origin) continue;
        // 同一候选标签页依次访问同源空白页，确保 sessionStorage 随该顶层页面保留。
        const temporary = target
          ? { ...target, tab: await driver.navigateTargetToInertOrigin(target, origin) }
          : await driver.createInertOriginTarget(browserContextId, origin);
        try {
          const result = await this.chrome.scripting.executeScript({
            target: { tabId: temporary.tab.id },
            func: restoreOriginState,
            args: [originState],
          });
          if (result?.[0]?.result?.ok !== true) throw new Error(`origin 恢复失败：${origin}`);
        } finally {
          if (!target) await driver.closeTarget(temporary.targetId);
        }
      }
    } catch (error) {
      const wrapped = new Error(`认证状态恢复失败：${errorMessage(error)}`);
      wrapped.code = 'CDP_AUTH_STATE_RESTORE_FAILED';
      throw wrapped;
    }
  }
}

export { normalizeOrigin };
