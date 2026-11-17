// SPDX-License-Identifier: Apache-2.0
package main

import (
	"sync"

	awgtun "github.com/sagernet/wireguard-go/tun"
	wgtun "golang.zx2c4.com/wireguard/tun"
)

// The AWG fork and the upstream userspace TCP/IP stack implement the same TUN
// contract. Only their named Event types differ. Keep cryptography in the AWG
// fork and use upstream WireGuard's actual gVisor TCP/UDP stack for the fixture.
// No host route, real TUN device, root permission, or hand-written TCP is needed.
type androidNetTUN struct {
	wgtun.Device
	events chan awgtun.Event
	done   chan struct{}
	once   sync.Once
	err    error
}

func adaptAndroidNetTUN(dev wgtun.Device) *androidNetTUN {
	result := &androidNetTUN{Device: dev, events: make(chan awgtun.Event, 16), done: make(chan struct{})}
	go func() {
		defer close(result.events)
		for {
			select {
			case event, ok := <-dev.Events():
				if !ok {
					return
				}
				select {
				case result.events <- awgtun.Event(event):
				case <-result.done:
					return
				}
			case <-result.done:
				return
			}
		}
	}()
	return result
}

func (t *androidNetTUN) Events() <-chan awgtun.Event { return t.events }

func (t *androidNetTUN) Close() error {
	t.once.Do(func() { close(t.done); t.err = t.Device.Close() })
	return t.err
}
