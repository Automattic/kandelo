/*
 * bt — a command-line client for /dev/kandelo/bluetooth.
 *
 * The browser page pairs a Web Bluetooth device (the dock's Bluetooth
 * button) and brokers it to whichever process opens the device. This tool
 * sends one request record and prints the matching response:
 *
 *   bt info
 *   bt services
 *   bt chars battery_service
 *   bt read battery_service battery_level      -> ok 5a
 *   bt write <svc> <chr> 0102ff
 *   bt notify heart_rate heart_rate_measurement on
 *   bt listen                                  # print notify/status records
 *
 * Responses go to stdout without the leading "ok " (exit 0); "err ..."
 * responses go to stderr (exit 1). Notification and status records that
 * arrive while waiting are printed to stderr as they come.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <kandelo/bluetooth.h>

static int read_full(int fd, void *buf, size_t len) {
	size_t got = 0;
	while (got < len) {
		ssize_t n = read(fd, (char *)buf + got, len - got);
		if (n < 0) {
			if (errno == EINTR) continue;
			return -1;
		}
		if (n == 0) return -1;
		got += (size_t)n;
	}
	return 0;
}

/* Read one record; returns its kind and fills seq/payload (NUL-terminated). */
static int read_record(int fd, uint32_t *seq, char *payload, size_t cap) {
	struct kandelo_bluetooth_record h;
	if (read_full(fd, &h, sizeof h) < 0) return -1;
	if (h.version != KANDELO_BLUETOOTH_RECORD_VERSION || h.len >= cap) {
		errno = EPROTO;
		return -1;
	}
	if (h.len && read_full(fd, payload, h.len) < 0) return -1;
	payload[h.len] = '\0';
	*seq = h.seq;
	return (int)h.kind;
}

int main(int argc, char **argv) {
	if (argc < 2) {
		fprintf(stderr, "usage: bt info|services|chars <svc>|read <svc> <chr>|"
		                "write <svc> <chr> <hex>|notify <svc> <chr> on|off|listen\n");
		return 2;
	}
	int fd = open(KANDELO_BLUETOOTH_DEVICE_PATH, O_RDWR);
	if (fd < 0) {
		if (errno == EBUSY)
			fprintf(stderr, "bt: %s is held by another process\n", KANDELO_BLUETOOTH_DEVICE_PATH);
		else
			perror("bt: open " KANDELO_BLUETOOTH_DEVICE_PATH);
		return 1;
	}
	static char payload[KANDELO_BLUETOOTH_MAX_PAYLOAD_BYTES + 1];
	uint32_t seq;

	if (strcmp(argv[1], "listen") == 0) {
		for (;;) {
			int kind = read_record(fd, &seq, payload, sizeof payload);
			if (kind < 0) { perror("bt: read"); return 1; }
			printf("%s\n", payload);
			fflush(stdout);
		}
	}

	/* Join the arguments into one command line. */
	char line[KANDELO_BLUETOOTH_MAX_PAYLOAD_BYTES];
	size_t at = 0;
	for (int i = 1; i < argc; i++) {
		int n = snprintf(line + at, sizeof line - at, "%s%s", i > 1 ? " " : "", argv[i]);
		if (n < 0 || (size_t)n >= sizeof line - at) { fprintf(stderr, "bt: command too long\n"); return 2; }
		at += (size_t)n;
	}

	uint32_t want = ((uint32_t)getpid() << 8) | 1;
	struct kandelo_bluetooth_record h = {
		.version = KANDELO_BLUETOOTH_RECORD_VERSION,
		.kind = KANDELO_BLUETOOTH_KIND_REQUEST,
		.seq = want,
		.len = (uint32_t)at,
	};
	char req[sizeof h + sizeof line];
	memcpy(req, &h, sizeof h);
	memcpy(req + sizeof h, line, at);
	if (write(fd, req, sizeof h + at) != (ssize_t)(sizeof h + at)) {
		perror("bt: write request");
		return 1;
	}

	for (;;) {
		int kind = read_record(fd, &seq, payload, sizeof payload);
		if (kind < 0) { perror("bt: read"); return 1; }
		if (kind == KANDELO_BLUETOOTH_KIND_RESPONSE && seq == want) {
			if (strncmp(payload, "ok", 2) == 0) {
				const char *rest = payload[2] == ' ' ? payload + 3 : payload + 2;
				if (*rest) printf("%s\n", rest);
				return 0;
			}
			fprintf(stderr, "bt: %s\n", strncmp(payload, "err ", 4) == 0 ? payload + 4 : payload);
			return 1;
		}
		/* Notifications and status changes that arrived meanwhile. */
		fprintf(stderr, "%s\n", payload);
	}
}
