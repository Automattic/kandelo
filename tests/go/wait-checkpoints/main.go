//go:build kandelo

package main

import (
	"fmt"
	"runtime"
	"sync/atomic"
	"time"
	_ "unsafe"
)

// This runtime fixture observes the target's existing private wait policy;
// ordinary applications do not access these implementation details.
//
//go:linkname hostWaitBound runtime.kandeloHeapSafepointBound
var hostWaitBound uint64

//go:linkname runtimeSleep runtime.usleep
func runtimeSleep(usec uint32)

// runtime.note is a single uintptr (runtime/note_other.go). These aliases
// belong only to this private-runtime fixture, whose build already opts out
// of linkname checks. Application and package builds keep the normal checks.
type runtimeNote struct{ key uintptr }

//go:linkname noteClear runtime.noteclear
func noteClear(note *runtimeNote)

//go:linkname noteWake runtime.notewakeup
func noteWake(note *runtimeNote)

// notetsleepg is the user-goroutine entry: it releases the scheduler P while
// waiting, unlike calling a low-level atomic wait from a running goroutine.
//
//go:linkname noteSleep runtime.notetsleepg
func noteSleep(note *runtimeNote, timeout int64) bool

func noteDeadlines() {
	var note runtimeNote
	for _, duration := range []time.Duration{0, 25 * time.Millisecond, 350 * time.Millisecond} {
		noteClear(&note)
		started := time.Now()
		if noteSleep(&note, int64(duration)) {
			panic("unnotified note reported a wakeup")
		}
		elapsed := time.Since(started)
		if elapsed < duration {
			panic("checkpoint shortened the note deadline")
		}
		fmt.Printf("note deadline=%s elapsed=%s\n", duration, elapsed)
	}
	noteClear(&note)
	noteWake(&note)
	if !noteSleep(&note, -1) {
		panic("already-notified note did not wake")
	}
	fmt.Println("GO NOTE DEADLINES PASS")
}

func noteWakeups() {
	for _, timeout := range []int64{int64(2 * time.Second), -1} {
		var note runtimeNote
		noteClear(&note)
		ready := make(chan struct{})
		done := make(chan time.Duration, 1)
		go func() {
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			started := time.Now()
			close(ready)
			if !noteSleep(&note, timeout) {
				panic("note deadline won over an earlier wakeup")
			}
			done <- time.Since(started)
		}()
		<-ready
		// Exercise a wake after multiple WebKit checkpoint intervals. This
		// delay triggers the operation; completion is observed through done.
		time.Sleep(350 * time.Millisecond)
		noteWake(&note)
		select {
		case elapsed := <-done:
			if elapsed < 250*time.Millisecond {
				panic("note wait returned before its notification")
			}
			fmt.Printf("note wake timeout=%d elapsed=%s\n", timeout, elapsed)
		case <-time.After(5 * time.Second):
			panic("note wakeup was lost")
		}
	}
	// Race notification with entry to the wait. Both orders must retain it.
	for round := 0; round < 12; round++ {
		var note runtimeNote
		noteClear(&note)
		ready := make(chan struct{})
		done := make(chan bool, 1)
		go func() {
			close(ready)
			done <- noteSleep(&note, -1)
		}()
		<-ready
		noteWake(&note)
		select {
		case woke := <-done:
			if !woke {
				panic("racing note notification was lost")
			}
		case <-time.After(5 * time.Second):
			panic("racing note wait did not finish")
		}
	}
	fmt.Println("GO NOTE WAKEUPS PASS")
}

func main() {
	runtime.GOMAXPROCS(2)
	const sentinel = 50_000_000
	for round := 0; round < 3; round++ {
		started := time.Now()
		atomic.StoreUint64(&hostWaitBound, sentinel)
		runtimeSleep(350_000)
		bound := atomic.LoadUint64(&hostWaitBound)
		elapsed := time.Since(started)
		fmt.Printf("wait round=%d bound=%d elapsed=%s\n", round, int64(bound), elapsed)
		if bound != 100_000_000 && int64(bound) != -1 {
			panic("runtime wait did not obtain the host checkpoint policy")
		}
		if elapsed < 350*time.Millisecond {
			panic("checkpoint interval shortened the requested sleep")
		}
	}
	noteDeadlines()
	noteWakeups()
	fmt.Println("GO WAIT CHECKPOINT PASS")
}
