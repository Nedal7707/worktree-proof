import { normalizeLaneId, normalizeLanes, ScopeValidationError } from './scope.js';

export class PlannerValidationError extends TypeError {
  constructor(message, code = 'ERR_PLANNER_VALIDATION') {
    super(message);
    this.name = 'PlannerValidationError';
    this.code = code;
  }
}

function asNonNegativeInteger(value, label, { allowInfinity = false } = {}) {
  if (allowInfinity && value === Infinity) {
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PlannerValidationError(`${label} must be a non-negative integer`, 'ERR_INVALID_CAPACITY');
  }
  return value;
}

function normalizeRequirementMap(value, laneId) {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new PlannerValidationError(
      `resource requirements for ${JSON.stringify(laneId)} must be an object`,
      'ERR_INVALID_REQUIREMENTS',
    );
  }
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (!key || typeof key !== 'string') {
      throw new PlannerValidationError(`resource names must be non-empty strings`, 'ERR_INVALID_REQUIREMENTS');
    }
    normalized[key] = asNonNegativeInteger(value[key], `resource requirement ${key}`);
  }
  return normalized;
}

function normalizeCapacity(capacity, fallback) {
  if (capacity === undefined || capacity === null) {
    return { maxConcurrent: fallback, pools: {} };
  }
  if (Number.isSafeInteger(capacity)) {
    return { maxConcurrent: asNonNegativeInteger(capacity, 'capacity'), pools: {} };
  }
  if (typeof capacity !== 'object' || Array.isArray(capacity)) {
    throw new PlannerValidationError('capacity must be an integer or object', 'ERR_INVALID_CAPACITY');
  }
  const rawMax = capacity.maxConcurrent ?? capacity.total ?? capacity.capacity ?? fallback;
  const maxConcurrent = asNonNegativeInteger(rawMax, 'capacity.maxConcurrent');
  const rawPools = capacity.pools ?? capacity.resources ?? {};
  if (typeof rawPools !== 'object' || Array.isArray(rawPools) || rawPools === null) {
    throw new PlannerValidationError('capacity pools must be an object', 'ERR_INVALID_CAPACITY');
  }
  const pools = {};
  for (const name of Object.keys(rawPools).sort()) {
    pools[name] = asNonNegativeInteger(rawPools[name], `capacity pool ${name}`);
  }
  return { maxConcurrent, pools };
}

function terminalFlag(item, backlogByLane) {
  if (item.terminal === true || item.terminalClosure === true) {
    return true;
  }
  const backlog = backlogByLane.get(item.laneId);
  return Boolean(backlog?.terminal === true || backlog?.terminalClosure === true);
}

function normalizeBacklog(backlog) {
  if (backlog === undefined || backlog === null) {
    return [];
  }
  if (!Array.isArray(backlog)) {
    throw new PlannerValidationError('backlog must be an array', 'ERR_INVALID_BACKLOG');
  }
  return backlog.map((item, index) => {
    if (typeof item === 'string') {
      return { laneId: normalizeLaneId(item), çž­¢G§²ÚîÆ­yÖenience alias for a capacity pool map.  It is
  // intentionally generic; no provider or model names are recognized here.
  const effectiveCapacity = capacity === undefined && resources !== undefined
    ? { pools: resources }
    : capacity;
  const normalizedCapacity = normalizeCapacity(effectiveCapacity, normalizedLanes.length);

  const candidates = normalizedLanes.map((lane, index) => {
    const requirements = normalizeRequirementMap(lane.requirements ?? lane.resourceRequirements, lane.laneId);
    const priority = lane.priority === undefined ? 0 : lane.priority;
    if (!Number.isSafeInteger(priority)) {
      throw new PlannerValidationError(`priority for ${JSON.stringify(lane.laneId)} must be an integer`, 'ERR_INVALID_PRIORITY');
    }
    return {
      lane,
      laneId: lane.laneId,
      fileScope: lane.fileScope,
      requirements,
      terminal: terminalFlag(lane, backlogByLane),
      priority,
      inputIndex: index,
    };
  });

  candidates.sort((a, b) => {
    if (a.terminal !== b.terminal) return a.terminal ? -1 : 1;
    if (a.priority !== b.priority) return b.priority - a.priority;
    const idOrder = a.laneId.localeCompare(b.laneId, 'en');
    if (idOrder !== 0) return idOrder;
    return a.inputIndex - b.inputIndex;
  });

  const remainingPools = { ...normalizedCapacity.pools };
  const allocated = [];
  const deferred = [];
  let remainingSlots = normalizedCapacity.maxConcurrent;

  for (const candidate of candidates) {
    const reasons = [];
    if (remainingSlots <= 0) {
      reasons.push('capacity exhausted');
    }
    for (const [name, amount] of Object.entries(candidate.requirements)) {
      if (!(name in remainingPools)) {
        reasons.push(`resource pool ${JSON.stringify(name)} unavailable`);
      } else if (amount > remainingPools[name]) {
        reasons.push(`resource pool ${JSON.stringify(name)} exhausted`);
      }
    }

    const allocation = {
      ...candidate.lane,
      laneId: candidate.laneId,
      fileScope: candidate.fileScope,
      terminal: candidate.terminal,
      priority: candidate.priority,
      requirements: { ...candidate.requirements },
    };
    if (reasons.length > 0) {
      deferred.push({ lane: allocation, reasons });
      continue;
    }

    remainingSlots -= 1;
    for (const [name, amount] of Object.entries(candidate.requirements)) {
      remainingPools[name] -= amount;
    }
    allocated.push(allocation);
  }

  const result = {
    capacity: {
      maxConcurrent: normalizedCapacity.maxConcurrent,
      pools: { ...normalizedCapacity.pools },
    },
    remaining: {
      slots: remainingSlots,
      pools: { ...remainingPools },
    },
    allocated,
    deferred,
  };
  // Aliases make the result convenient for a CLI without creating a second
  // scheduling representation.
  result.selected = allocated;
  result.terminalBacklog = allocated.filter((lane) => lane.terminal).map((lane) => lane.laneId);
  return result;
}

export const plan = planCapacity;
