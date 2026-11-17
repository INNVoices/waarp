module waarp-audit-userspace

go 1.26.0

toolchain go1.26.11

require (
	github.com/sagernet/wireguard-go v0.0.8-0.20260929150556-6731c7387c81
	golang.org/x/net v0.57.0
	golang.zx2c4.com/wireguard v0.0.0-20261024220952-b3bc704ef0ee
)

require (
	github.com/google/btree v1.1.2 // indirect
	github.com/sagernet/sing v0.9.7-0.20260929150544-0ad23b637bd4 // indirect
	golang.org/x/crypto v0.54.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/time v0.7.0 // indirect
	golang.zx2c4.com/wintun v0.0.0-20230126152724-0fa3db229ce2 // indirect
	gvisor.dev/gvisor v0.0.0-20250503011706-39ed1f5ac29c // indirect
)

replace github.com/sagernet/wireguard-go => github.com/Leadaxe/wireguard-go-awg2-lx v0.0.0-20260929174416-64065e6826ad
