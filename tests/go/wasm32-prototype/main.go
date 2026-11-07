package main

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"runtime"
	"sync/atomic"
	"unsafe"
)

type sample struct {
	Tag     uint32
	Pointer *int32
	Wide    uint64
	Chain   **int32
	Tail    uint8
}
type aligned struct {
	Tag  uint32
	Wide uint64
	Tail uint8
}
type adder int

func (a adder) Add(x int) int { return int(a) + x }

type addInterface interface{ Add(int) int }

//go:noinline
func follow(p **int32) *int32 { return *p }

//go:noinline
func deep(n int) int {
	var pad [64]uint64
	pad[n%len(pad)] = uint64(n)
	if n == 0 {
		runtime.KeepAlive(&pad)
		return 0
	}
	result := deep(n - 1)
	runtime.KeepAlive(&pad)
	return result + int(pad[n%len(pad)])
}
func recoverProbe() (ok bool) {
	defer func() { ok = recover() == "wasm32-probe" }()
	panic("wasm32-probe")
}
func assert(v bool, message string) {
	if !v {
		panic(message)
	}
}
func main() {
	assert(runtime.GOOS == "kandelo", "wrong OS")
	assert(runtime.GOARCH == "wasm32", "wrong architecture")
	var s sample
	var a aligned
	layout := map[string]uintptr{"pointerBytes": unsafe.Sizeof(s.Pointer), "intBytes": unsafe.Sizeof(int(0)), "int64Align": unsafe.Alignof(uint64(0)), "sampleBytes": unsafe.Sizeof(s), "sampleAlign": unsafe.Alignof(s), "pointerOffset": unsafe.Offsetof(s.Pointer), "wideOffset": unsafe.Offsetof(s.Wide), "chainOffset": unsafe.Offsetof(s.Chain), "tailOffset": unsafe.Offsetof(s.Tail), "alignedBytes": unsafe.Sizeof(a), "alignedWideOffset": unsafe.Offsetof(a.Wide)}
	assert(layout["pointerBytes"] == 4 && layout["intBytes"] == 4 && layout["int64Align"] == 8 && layout["sampleBytes"] == 24, "wrong wasm32 layout")
	buf := make([]int32, 2048)
	buf[1024] = 37
	s.Pointer = &buf[1024]
	buf = nil
	runtime.GC() // Functional root-retention check, not a memory-reclamation measurement.
	assert(*s.Pointer == 37, "interior pointer lost through GC")
	p := &s.Pointer
	*p = new(int32)
	**p = 41
	assert(follow(p) == s.Pointer && *follow(p) == 41, "field address lost aliasing")
	var receiver addInterface = adder(7)
	seed := 3
	fn := func(x int) int { return receiver.Add(x) + seed }
	assert(fn(5) == 15, "closure/interface call")
	value := reflect.ValueOf(fn)
	assert(value.Call([]reflect.Value{reflect.ValueOf(5)})[0].Int() == 15, "reflect call")
	pc := value.Pointer()
	assert(pc != 0 && runtime.FuncForPC(pc) != nil, "function handle/PC mapping")
	assert(deep(256) == 32896, "stack growth/return continuation")
	assert(recoverProbe(), "panic/recover")
	ch := make(chan int)
	go func() { runtime.Gosched(); ch <- fn(5) }()
	assert(<-ch == 15, "goroutine scheduling")

	// Locked goroutines remain live together, requiring separate kernel threads.
	runtime.GOMAXPROCS(2)
	ready := make(chan struct{}, 4)
	release := make(chan struct{})
	finished := make(chan struct{}, 4)
	var count atomic.Uint64
	var pointer atomic.Pointer[int32]
	for worker := 0; worker < 4; worker++ {
		go func() {
			runtime.LockOSThread()
			ready <- struct{}{}
			<-release
			for n := 0; n < 1000; n++ {
				count.Add(1)
			}
			pointer.Store(new(int32))
			assert(pointer.Load() != nil, "atomic pointer lost")
			finished <- struct{}{}
			runtime.UnlockOSThread()
		}()
	}
	for worker := 0; worker < 4; worker++ {
		<-ready
	}
	runtime.GC()
	close(release)
	for worker := 0; worker < 4; worker++ {
		<-finished
	}
	assert(count.Load() == 4000, "shared uint64 atomic update lost")
	assert(count.And(255) == 4000 && count.Load() == 160, "uint64 atomic AND")
	assert(count.Or(15) == 160 && count.Load() == 175, "uint64 atomic OR")
	var narrow atomic.Uint32
	narrow.Store(240)
	assert(narrow.And(15) == 240 && narrow.Load() == 0, "uint32 atomic AND")
	assert(narrow.Or(7) == 0 && narrow.Load() == 7, "uint32 atomic OR")
	var slots struct { pointer atomic.Pointer[int32]; guard uint32 }
	slots.guard = 0x12345678
	pointed := new(int32)
	slots.pointer.Store(pointed)
	assert(slots.pointer.CompareAndSwap(pointed, nil), "pointer atomic CAS")
	assert(slots.pointer.Swap(pointed) == nil && slots.pointer.Load() == pointed, "pointer atomic exchange")
	assert(slots.guard == 0x12345678, "pointer atomic wrote beyond four-byte slot")

	result := map[string]any{"goVersion": runtime.Version(), "goos": runtime.GOOS, "goarch": runtime.GOARCH, "layout": layout, "checks": []string{"interior-pointer-GC-root", "escaping-field-address-aliasing", "closure-and-interface", "reflection-call", "function-PC-mapping", "stack-growth", "panic-recover", "goroutine-channel", "concurrent-locked-Ms-and-atomics"}}
	out, err := json.Marshal(result)
	if err != nil {
		panic(err)
	}
	fmt.Fprintln(os.Stdout, string(out))
}
