// Emits the webhook contract fixture bodies.
//
// The bodies are produced by running encoding/json over the AhaSend server's
// own payload structs (producer-structs.go, extracted verbatim by
// extract-producer-structs.sh), so their serialization semantics come from Go
// rather than from a transcription: RFC3339Nano timestamps, canonical UUID
// rendering, `[]` vs `null` for slices, `*bool` omission, zero-value emission,
// HTML escaping, and field order.
//
// Running the real sender is not an option here — it needs infrastructure
// this tool has no access to — so the payload types are compiled standalone
// instead. That is the reason this file exists rather than a pointer at the
// sender.
//
// Every value below is chosen to be one the producer could actually emit.
//
// Regenerating — see contracts/webhooks/README.md for the whole procedure,
// including the steps no tool performs. The server checkout must be a normal clone — so `origin/master`
// exists for the extractor's reachability check — detached at the commit being
// attested to, and outside both repositories. <output-dir> must already exist;
// write() panics otherwise, and it is resolved relative to this directory, so
// prefer an absolute path. It must hold nothing but the emitted bodies — the
// resigner refuses files no manifest claims.
//
//	./contracts/webhooks/tools/extract-producer-structs.sh <server-repo> <sha>
//	(cd contracts/webhooks/tools && go run . <abs-output-dir>)   # own Go module
//	node contracts/webhooks/tools/resign-fixtures.mjs rewrite <abs-output-dir>
//	npm run contracts:generate
//
// Several steps are not automated — copying serverCommit, setting derivedAt,
// moving the digest pins. contracts/webhooks/README.md lists them; do not
// duplicate that list here, because the copies drift.
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
			// UserAgent and IP are omitted when empty and a delivery event sets
			// neither, so they are absent rather than empty. IsBot is always
			// serialized, so it is false on every message event.
			//
			// A successful delivery records an attempt but no classification:
			// only a failure is classified. These are the published reference
			// values for a delivered event.
			DeliveryAttempt: &DeliveryAttempt{
				SMTPCode:           250,
				EnhancedStatusCode: "2.0.0",
				Response:           "OK: queued",
				Command:            "DATA",
			},
		},
	})

	// The campaign payload has its own type rather than sharing the
	// transactional one, so it is serialised separately: a field that differs
	// between the two is invisible to a corpus that only ever emits one.
	//
	// The attempt values are the published reference values for a bounce,
	// verbatim, so nothing here has to be reasoned about. `description` is
	// deliberately absent: no reference value populates it, and the SDK
	// forwards it untouched, so it is covered by a synthetic fixture rather
	// than by inventing a payload for it.
	write(outDir+"/configured-webhook-campaign-message-bounced.json", CampaignMessageWebhookPayload{
		Type:      "message.bounced",
		Timestamp: mustParse("2026-07-14T15:06:44Z"),
		WebhookID: uuid.MustParse("9aaf3ea1-b6f8-42c9-a930-5601b530bdd1"),
		Data: CampaignMessageWebhookData{
			AccountID: uuid.MustParse("835d2a9f-2c7e-4e8f-96f6-5b7d4b8521aa"),
			Event:     "on_bounced",
			From:      "Campaigns <news@capture.example>",
			Recipient: "receiver@capture.example",
			Subject:   "Captured campaign bounce — byte exact",
			MessageID: "<capture-campaign-01@capture.example>",
			ID:        "capture-campaign-message-01",
			DeliveryAttempt: &DeliveryAttempt{
				Classification:     "InvalidRecipient",
				SMTPCode:           550,
				EnhancedStatusCode: "5.1.1",
				Response:           "The email account that you tried to reach does not exist",
				Command:            "RCPT TO",
			},
		},
	})

	// The routing event's timestamp comes from a source with microsecond
	// resolution, so that is the finest resolution available.
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
			// The reply text with the quoted block trimmed, as the sender's reply
			// parser produces it.
			ReplyFromPlainBody: "Line one.\r\nLine two.",
			// Order matters and is not free: conventional attachments come first,
			// then inline parts, then any remaining part that carried a filename. A
			// conventional attachment therefore always precedes an embedded part
			// that carried no Content-Disposition header.
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
			// Every header key is copied through, so a payload with a populated
			// From/To/Subject/Date carries them here too.
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
