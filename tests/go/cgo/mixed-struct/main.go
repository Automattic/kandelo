package main

/*
#include <stdint.h>

static int target = 37;

struct mixed {
    uint32_t first;
    int *pointer;
    int *pointers[2];
    uint32_t last;
};

static struct mixed make_mixed(void) {
    struct mixed value = {11, &target, {&target, &target}, 29};
    return value;
}

static int *target_address(void) { return &target; }

static int check_mixed(struct mixed value) {
    return value.first == 11 && value.pointer == &target &&
        value.pointers[0] == &target && value.pointers[1] == &target &&
        value.last == 29;
}

static void callback(void) {}

struct nested {
    uint64_t wide;
    int *pointer;
    double ratio;
};

struct aggregate {
    uint32_t tag;
    struct nested nested;
    void (*callback)(void);
    uint16_t tail;
};

static struct aggregate make_aggregate(void) {
    struct aggregate value = {7, {0x1122334455667788ULL, &target, 2.5}, callback, 19};
    return value;
}

static int check_aggregate(struct aggregate value) {
    return value.tag == 7 && value.nested.wide == 0x1122334455667788ULL &&
        value.nested.pointer == &target && value.nested.ratio == 2.5 &&
        value.callback == callback && value.tail == 19;
}

struct __attribute__((packed)) packed {
    uint8_t tag;
    int *pointer;
    uint64_t wide;
    uint8_t tail;
};

static struct packed make_packed(void) {
    struct packed value = {13, &target, 0x8877665544332211ULL, 17};
    return value;
}

static int check_packed(struct packed value) {
    return value.tag == 13 && value.pointer == &target &&
        value.wide == 0x8877665544332211ULL && value.tail == 17;
}

struct bulk_pair {
    unsigned char *key;
    unsigned char *value;
    uint32_t length;
};

static unsigned char bulk_values[24][2];

static struct bulk_pair make_bulk_pair(unsigned int index) {
    bulk_values[index][0] = (unsigned char)(index + 1);
    bulk_values[index][1] = (unsigned char)(index + 37);
    struct bulk_pair pair = {
        &bulk_values[index][0], &bulk_values[index][1], index + 101
    };
    return pair;
}

// A long sequence of 12-byte aggregates exercises successive argument offsets,
// unlike one aggregate round-trip. Every pointer refers to C-owned storage.
static int check_bulk_pairs(
    int *prefix,
    struct bulk_pair p0, struct bulk_pair p1, struct bulk_pair p2,
    struct bulk_pair p3, struct bulk_pair p4, struct bulk_pair p5,
    struct bulk_pair p6, struct bulk_pair p7, struct bulk_pair p8,
    struct bulk_pair p9, struct bulk_pair p10, struct bulk_pair p11,
    struct bulk_pair p12, struct bulk_pair p13, struct bulk_pair p14,
    struct bulk_pair p15, struct bulk_pair p16, struct bulk_pair p17,
    struct bulk_pair p18, struct bulk_pair p19, struct bulk_pair p20,
    struct bulk_pair p21, struct bulk_pair p22, struct bulk_pair p23,
    int *suffix
) {
    if (prefix != &target || suffix != &target) {
        return 0;
    }
    struct bulk_pair pairs[] = {
        p0, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11,
        p12, p13, p14, p15, p16, p17, p18, p19, p20, p21, p22, p23
    };
    for (unsigned int i = 0; i < 24; i++) {
        if (pairs[i].key != &bulk_values[i][0] ||
            pairs[i].value != &bulk_values[i][1] ||
            *pairs[i].key != i + 1 || *pairs[i].value != i + 37 ||
            pairs[i].length != i + 101) {
            return 0;
        }
    }
    return 1;
}
*/
import "C"

import (
	"encoding/binary"
	"fmt"
	"unsafe"
)

func main() {
	value := C.make_mixed()
	if got := unsafe.Sizeof(value); got != uintptr(C.sizeof_struct_mixed) {
		panic(fmt.Sprintf("C struct size changed: %d", got))
	}
	if unsafe.Offsetof(value.pointer) != 4 || unsafe.Offsetof(value.pointers) != 8 || unsafe.Offsetof(value.last) != 16 {
		panic("C pointer-bearing struct offsets changed")
	}
	target := uintptr(unsafe.Pointer(C.target_address()))
	if value.first != 11 || value.last != 29 || uintptr(value.pointer) != target ||
		uintptr(value.pointers[0]) != target || uintptr(value.pointers[1]) != target {
		panic(fmt.Sprintf("C pointer-bearing struct fields failed: first=%d last=%d pointer=%x", value.first, value.last, value.pointer))
	}
	if C.check_mixed(value) != 1 {
		panic("C by-value struct argument failed")
	}
	aggregate := C.make_aggregate()
	if unsafe.Sizeof(aggregate) != uintptr(C.sizeof_struct_aggregate) ||
		unsafe.Offsetof(aggregate.nested) != 8 || unsafe.Offsetof(aggregate.callback) != 32 ||
		unsafe.Offsetof(aggregate.tail) != 36 || unsafe.Offsetof(aggregate.nested.pointer) != 8 {
		panic("C nested aggregate layout changed")
	}
	if aggregate.tag != 7 || aggregate.nested.wide != 0x1122334455667788 ||
		uintptr(aggregate.nested.pointer) != target || aggregate.nested.ratio != 2.5 ||
		aggregate.tail != 19 || C.check_aggregate(aggregate) != 1 {
		panic("C nested aggregate return or by-value argument failed")
	}
	packed := C.make_packed()
	if unsafe.Sizeof(packed) != uintptr(C.sizeof_struct_packed) {
		panic("C packed struct size changed")
	}
	packedBytes := unsafe.Slice((*byte)(unsafe.Pointer(&packed)), int(C.sizeof_struct_packed))
	if len(packedBytes) != 14 || packedBytes[0] != 13 ||
		uintptr(binary.LittleEndian.Uint32(packedBytes[1:5])) != target ||
		binary.LittleEndian.Uint64(packedBytes[5:13]) != 0x8877665544332211 ||
		packedBytes[13] != 17 || C.check_packed(packed) != 1 {
		panic("C packed aggregate return or by-value argument failed")
	}
	var pairs [24]C.struct_bulk_pair
	for i := range pairs {
		pairs[i] = C.make_bulk_pair(C.uint(i))
	}
	if unsafe.Sizeof(pairs[0]) != 12 || C.check_bulk_pairs(
		C.target_address(),
		pairs[0], pairs[1], pairs[2], pairs[3], pairs[4], pairs[5],
		pairs[6], pairs[7], pairs[8], pairs[9], pairs[10], pairs[11],
		pairs[12], pairs[13], pairs[14], pairs[15], pairs[16], pairs[17],
		pairs[18], pairs[19], pairs[20], pairs[21], pairs[22], pairs[23],
		C.target_address(),
	) != 1 {
		panic("C bulk pointer-bearing aggregate arguments failed")
	}
	fmt.Println("CGO MIXED STRUCT PASS")
}
