// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/sagernet/wireguard-go/device"
	"golang.org/x/net/dns/dnsmessage"
)

func TestAndroidFixtureChild(t *testing.T) {
	port, exists := os.LookupEnv("WAARP_TEST_CHILD_PORT")
	if !exists {
		return
	}
	number, _ := strconv.Atoi(port)
	if executeAndroidServer(number, os.Getenv("WAARP_TEST_CHILD_REPORT")) != nil {
		os.Exit(1)
	}
	os.Exit(0)
}

// Verifies the new fixture itself before asking Android to use it. Two fresh
// client Devices prove authenticated packets, EDNS parsing, and shutdown evidence.
func TestAndroidServerEncryptedEDNSAndClientRecreation(t *testing.T) {
	reserved, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal("reserve_fixture_port")
	}
	port := reserved.LocalAddr().(*net.UDPAddr).Port
	reserved.Close()
	reportPath := filepath.Join(t.TempDir(), "proof.json")
	executable, _ := os.Executable()
	child := exec.Command(executable, "-test.run=^TestAndroidFixtureChild$")
	child.Env = append(os.Environ(), "WAARP_TEST_CHILD_PORT="+strconv.Itoa(port), "WAARP_TEST_CHILD_REPORT="+reportPath)
	if child.Start() != nil {
		t.Fatal("start_fixture")
	}
	finished := false
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	t.Cleanup(func() {
		if !finished {
			child.Process.Kill()
			<-done
		}
	})
	client := &http.Client{Timeout: time.Second}
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	ready := false
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		response, requestErr := client.Get(base + "/health")
		if requestErr == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				ready = true
				break
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !ready {
		t.Fatal("fixture_not_ready")
	}
	privateKey, _ := ecdh.X25519().GenerateKey(rand.Reader)
	request, _ := json.Marshal(map[string]string{"public_key": base64.StdEncoding.EncodeToString(privateKey.PublicKey().Bytes())})
	response, err := client.Post(base+"/register", "application/json", bytes.NewReader(request))
	if err != nil {
		t.Fatal("register_client")
	}
	var peer struct {
		PublicKey string `json:"server_public_key"`
	}
	decodeErr := json.NewDecoder(response.Body).Decode(&peer)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || decodeErr != nil {
		t.Fatal("register_response")
	}
	publicKey, err := base64.StdEncoding.DecodeString(peer.PublicKey)
	if err != nil || len(publicKey) != 32 {
		t.Fatal("server_public_key")
	}
	for cycle := 0; cycle < 2; cycle++ {
		func() {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			tun := newMemoryTUN(1280)
			bind := &udpBind{family: "udp4", listenIP: net.IPv4(127, 0, 0, 1)}
			dev := device.NewDevice(ctx, tun, bind, &device.Logger{Verbosef: device.DiscardLogf, Errorf: device.DiscardLogf}, 1)
			defer dev.Close()
			uapi := "private_key=" + hex.EncodeToString(privateKey.Bytes()) + "\n" + localAWG +
				"replace_peers=true\npublic_key=" + hex.EncodeToString(publicKey) +
				"\nendpoint=127.0.0.1:" + strconv.Itoa(port) + "\nallowed_ip=10.77.0.1/32\n"
			if dev.IpcSet(uapi) != nil || dev.Up() != nil {
				t.Fatal("start_client")
			}
			configuration := &config{source: localClientIP, dns: localServerIP}
			packet, id, sourcePort, packetErr := dnsPacket(configuration)
			if packetErr != nil {
				t.Fatal("create_dns_request")
			}
			// Add a valid EDNS OPT to exercise the production native resolver's query shape.
			var dns dnsmessage.Message
			dns.Unpack(packet[28:])
			dns.Additionals = []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{
				Name: dnsmessage.MustNewName("."), Type: dnsmessage.TypeOPT, Class: dnsmessage.Class(1232)}, Body: &dnsmessage.OPTResource{}}}
			payload, packErr := dns.Pack()
			if packErr != nil {
				t.Fatal("encode_edns")
			}
			packet = replaceDNSPayload(packet, payload)
			tun.outbound <- packet
			deadline := time.NewTimer(8 * time.Second)
			defer deadline.Stop()
			retry := time.NewTicker(250 * time.Millisecond)
			defer retry.Stop()
			for {
				select {
				case incoming := <-tun.inbound:
					if matches, code, answers := dnsResponse(incoming, configuration, id, sourcePort); matches && code == 0 && answers == 1 {
						if !handshakeComplete(dev) {
							t.Fatal("missing_authenticated_handshake")
						}
						return
					}
				case <-retry.C:
					tun.outbound <- packet
				case <-deadline.C:
					var snapshot androidProof
					if state, stateErr := client.Get(base + "/proof"); stateErr == nil {
						json.NewDecoder(state.Body).Decode(&snapshot)
						state.Body.Close()
					}
					t.Fatalf("encrypted_edns_timeout_cycle_%d: %+v", cycle, snapshot)
				}
			}
		}()
	}
	child.Process.Signal(syscall.SIGTERM)
	select {
	case err = <-done:
		finished = true
		if err != nil {
			t.Fatal("fixture_shutdown")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("fixture_shutdown_timeout")
	}
	file, err := os.Open(reportPath)
	if err != nil {
		t.Fatal("proof_file")
	}
	defer file.Close()
	var proof androidProof
	if json.NewDecoder(file).Decode(&proof) != nil || !proof.Passed {
		t.Fatalf("fixture_proof_failed: %+v", proof)
	}
}

func replaceDNSPayload(packet, payload []byte) []byte {
	result := append(append([]byte(nil), packet[:28]...), payload...)
	result[2], result[3] = byte(len(result)>>8), byte(len(result))
	result[24], result[25] = byte((8+len(payload))>>8), byte(8+len(payload))
	result[10], result[11] = 0, 0
	var checksum uint32
	for index := 0; index < 20; index += 2 {
		checksum += uint32(result[index])<<8 | uint32(result[index+1])
	}
	for checksum > 0xffff {
		checksum = (checksum & 0xffff) + (checksum >> 16)
	}
	checksum = ^checksum
	result[10], result[11] = byte(checksum>>8), byte(checksum)
	return result
}
