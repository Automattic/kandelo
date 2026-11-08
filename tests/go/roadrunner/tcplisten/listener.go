package tcplisten

import (
	"fmt"
	"net"
	"strings"
)

func CreateListener(address string) (net.Listener, error) {
	if strings.HasPrefix(address, "tcp://") {
		return net.Listen("tcp", strings.TrimPrefix(address, "tcp://"))
	}
	if strings.Contains(address, "://") {
		return nil, fmt.Errorf("unsupported listener address: %s", address)
	}
	return net.Listen("tcp", address)
}
