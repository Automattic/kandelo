type Memory64Descriptor = WebAssembly.MemoryDescriptor & {
  initial: number | bigint;
  maximum?: number | bigint;
  address: "i64";
};

function assertPageCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

function memory64Descriptor(
  initialPages: number,
  maximumPages: number,
  shared: boolean,
  pageCountType: "bigint" | "number",
): Memory64Descriptor {
  const initial = pageCountType === "bigint" ? BigInt(initialPages) : initialPages;
  const maximum = pageCountType === "bigint" ? BigInt(maximumPages) : maximumPages;
  return {
    initial,
    maximum,
    shared,
    address: "i64",
  } as Memory64Descriptor;
}

/**
 * Create a memory64 WebAssembly.Memory across engines with different JS API
 * coercion behavior. V8 accepts BigInt page counts for memory64 descriptors;
 * Safari currently rejects them and expects numbers.
 */
export function createMemory64(
  initialPages: number,
  maximumPages: number,
  shared = true,
): WebAssembly.Memory {
  assertPageCount(initialPages, "memory initial pages");
  assertPageCount(maximumPages, "memory maximum pages");
  try {
    return new WebAssembly.Memory(
      memory64Descriptor(initialPages, maximumPages, shared, "bigint") as unknown as WebAssembly.MemoryDescriptor,
    );
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return new WebAssembly.Memory(
      memory64Descriptor(initialPages, maximumPages, shared, "number") as unknown as WebAssembly.MemoryDescriptor,
    );
  }
}

export function createMemoryForPtrWidth(
  ptrWidth: 4 | 8,
  initialPages: number,
  maximumPages: number,
  shared = true,
): WebAssembly.Memory {
  if (ptrWidth === 8) {
    return createMemory64(initialPages, maximumPages, shared);
  }
  return new WebAssembly.Memory({
    initial: initialPages,
    maximum: maximumPages,
    shared,
  });
}

/**
 * Grow memory64 with BigInt first, then retry with number for engines whose
 * JS API still coerces the delta as a number.
 */
export function growMemory64(memory: WebAssembly.Memory, deltaPages: number): void {
  assertPageCount(deltaPages, "memory grow pages");
  try {
    memory.grow(BigInt(deltaPages) as unknown as number);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    memory.grow(deltaPages);
  }
}

export function growMemoryForPtrWidth(
  memory: WebAssembly.Memory,
  deltaPages: number,
  ptrWidth: 4 | 8,
): void {
  if (ptrWidth === 8) {
    growMemory64(memory, deltaPages);
  } else {
    memory.grow(deltaPages);
  }
}
