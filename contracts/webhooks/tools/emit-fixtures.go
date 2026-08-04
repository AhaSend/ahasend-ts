// Emits the webhook contract fixture bodies.
//
// The bodies are produced by running encoding/json over the AhaSend server's
// own payload structs (producer-structs.go, extracted verbatim by
// extract-producer-structs.sh), so their serialization semantics come from Go
// rather than from a transcription: RFC3339Nano timestamps, canonical UUID
// rendering, `[]` vs `null` for slices, `*bool` omission, zero-value emission,
// HTML escaping, and field order.
//
// Running the real producer is not an option — a transitive init() reaches
// db.New() and requires a live database — so the structs are compiled
// standalone instead. That is the reason this file exists rather than a
// pointer at the server.
//
// Every value below is chosen to be one the producer could actually emit.
// Regenerate with:
//
//	./contracts/webhooks/tools/extract-producer-structs.sh <server-repo>
//	go run ./contracts/webhooks/tools <output-dir>
//	node contracts/webhooks/tools/resign-fixtures.mjs rewrite <output-dir>
//	npm run contracts:generate
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/google/uuid"
)

func write(path string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		panic(err)
	}
	fmt.Printf("%-52s %d bytes\n", path, len(b))
}

func mustParse(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		panic(err)
	}
	return parsed
}

func main() {
	if len(os.Args) < 2 {
		panic("usage: emit-fixtures <output-dir>")
	}
	outDir := os.Args[1]

	// The delivered event's timestamp comes from time.Unix(seconds, 0) on the
	// production path, so it carries no fractional part.
	write(outDir+"/configured-webhook-message-delivered.json", MessageWebhookPayload{
		Type:      "message.delivered",
		Timestamp: mustParse("2026-07-14T15:03:21Z"),
		WebhookID: uuid.MustParse("9aaf3ea1-b6f8-42c9-a930-5601b530bdd1"),
		Data: MessageWebhookData{
			AccountID: uuid.MustParse("835d2a9f-2c7e-4e8f-96f6-5b7d4b8521aa"),
			Event:     "on_delivered",
			From:      "sender@capture.example",
			Recipient: "receiver@capture.example",
			Subject:   "Captured delivery — byte exact",
			MessageID: "<capture-delivered-01@capture.example>",
			ID:        "capture-message-01",
			// UserAgent, IP and IsBot carry omitempty and a delivery event
			// sets none of them, so they are absent rather than empty.
		},
	})

	// The routing event's timestamp is the message's created_at, a Postgres
	// TIMESTAMP, so microseconds are the finest resolution available.
	plainBody := "Line one.\r\nLine two.\r\n\r\n" +
		"On Tue, 14 Jul 2026 at 15:00, Support <support@capture.example> wrote:\r\n" +
		"> How can we help?"

	write(outDir+"/route-message-routing.json", MessagePayload{
		Type:      "message.routing",
		Timestamp: mustParse("2026-07-14T15:04:07.123456Z"),
		RouteID:   uuid.MustParse("b33c56aa-4bb8-4796-a44e-e204c2a9cb49"),
		Data: MessageData{
			ID:        "capture-route-message-01",
			From:      "Customer <customer@example.net>",
			ReplyTo:   "customer@example.net",
			To:        "inbound@capture.example",
			Subject:   "Routing capture",
			MessageID: "<capture-routing-01@example.net>",
			// Raw RFC5322 length of the source message, so comfortably larger
			// than the rendered bodies and attachments below.
			Size:       1187,
			SpamScore:  0.1,
			Bounce:     false,
			CC:         "",
			Date:       "Tue, 14 Jul 2026 15:04:05 +0000",
			InReplyTo:  "",
			References: "",
			// Set only for auto-replies; a human reply leaves it empty.
			AutoSubmitted: "",
			HTMLBody:      `<p>Line one.<br>Line two.</p><img src="cid:logo-123">`,
			PlainBody:     plainBody,
			// erp.Parse(plain_body) — verified against the producer's pinned
			// email-reply-parser revision, which trims the quoted block.
			ReplyFromPlainBody: "Line one.\r\nLine two.",
			// Order matters and is not free: routeAttachments() concatenates
			// envelope.Attachments, then Inlines, then filename-bearing
			// OtherParts. A conventional attachment therefore always precedes
			// an embedded part that carried no Content-Disposition header.
			Attachments: []MessageAttachmentsPayload{
				{
					Filename:    "invoice.pdf",
					ContentType: "application/pdf",
					ContentID:   "",
					Disposition: "attachment",
					Data:        "cGRmLWJ5dGVz",
				},
				{
					Filename:    "logo.png",
					ContentType: "image/png",
					ContentID:   "logo-123",
					Disposition: "",
					Data:        "aW1hZ2UtYnl0ZXM=",
				},
			},
			// message.Data.Headers() copies every header key, so a payload
			// with a populated From/To/Subject/Date carries them here too.
			Headers: map[string]string{
				"Content-Type":  "multipart/mixed; boundary=\"mix\"",
				"Date":          "Tue, 14 Jul 2026 15:04:05 +0000",
				"From":          "Customer <customer@example.net>",
				"Message-Id":    "<capture-routing-01@example.net>",
				"Mime-Version":  "1.0",
				"Subject":       "Routing capture",
				"To":            "inbound@capture.example",
				"X-Capture":     "route-01",
				"X-Literal-Tab": "one\t two",
			},
		},
	})
}
