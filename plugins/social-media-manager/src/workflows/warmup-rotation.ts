import type { WorkflowDocInput } from '@enkaku/protocol'

/**
 * The three-platform warm-up rotation (plan 314), shipped by this plugin as
 * `smm/warmup-rotation` (plan 315).
 *
 * One session of warm-up per run. Which platform a phone warms up on is
 * `($device.number + $params.slot) % 3` — TikTok, Instagram, YouTube — so a
 * fleet of forty splits 13/14/13 per session and every phone reaches all three
 * platforms across slots 0, 1 and 2. Keyed on the phone's durable NUMBER, never
 * its position in a batch, because the three sessions are three separate
 * dispatches (CLAUDE.md, "$device.number is the durable device key").
 *
 * Each branch shuffles that platform's activities with an 8-20 s random gap,
 * so no two phones walk the same sequence at the same rhythm.
 *
 * Refs are `@latest` on purpose: the platform packs version independently of
 * this one, and a pin to today's tiktok version would point at a version a
 * fresh farm, seeded with a newer pack, never had. The farm's `/validate`
 * says so (`W_WORKFLOW_LATEST_REF`), and that is the honest trade.
 *
 * The document was authored in Studio on the owner's farm and exported as-is;
 * edit it there (duplicate `smm/warmup-rotation`), then paste it back here.
 */
export const warmupRotation: WorkflowDocInput = {
  "schema": 2,
  "name": "warmup-rotation",
  "title": "Warmup rotation",
  "description": "Rotates platform by session (Latin square on $device.number), and shuffles the scripts inside each platform.",
  "params": [
    {
      "name": "slot",
      "type": "number",
      "required": true,
      "default": 0,
      "title": "Session slot",
      "description": ""
    }
  ],
  "entry": "start",
  "nodes": [
    {
      "id": "start",
      "title": "Start",
      "ui": {
        "x": 0,
        "y": 0
      },
      "enabled": true,
      "kind": "start",
      "next": "pick"
    },
    {
      "id": "tt-mix",
      "title": "TikTok warm-up (random order)",
      "ui": {
        "x": -360,
        "y": 260
      },
      "enabled": true,
      "kind": "shuffle",
      "members": [
        "tt-fyp",
        "tt-notif"
      ],
      "between": {
        "expr": "8000 + $random * 12000"
      },
      "betweenMaxMs": 20000,
      "continueOnMemberFailure": true,
      "next": "done"
    },
    {
      "id": "tt-fyp",
      "title": "auto-scroll@1.23.0",
      "ui": {
        "x": -360,
        "y": 380
      },
      "enabled": true,
      "kind": "script",
      "script": "tiktok/auto-scroll@latest",
      "params": {}
    },
    {
      "id": "tt-notif",
      "title": "notification-activity@1.23.0",
      "ui": {
        "x": -360,
        "y": 450
      },
      "enabled": true,
      "kind": "script",
      "script": "tiktok/notification-activity@latest",
      "params": {}
    },
    {
      "id": "ig-mix",
      "title": "Instagram warm-up (random order)",
      "ui": {
        "x": 0,
        "y": 260
      },
      "enabled": true,
      "kind": "shuffle",
      "members": [
        "ig-reels",
        "ig-feed",
        "ig-stories",
        "ig-explore",
        "ig-activity",
        "ig-inbox",
        "ig-profile"
      ],
      "between": {
        "expr": "8000 + $random * 12000"
      },
      "betweenMaxMs": 20000,
      "continueOnMemberFailure": true,
      "next": "done"
    },
    {
      "id": "ig-reels",
      "title": "scroll-reels@0.2.0",
      "ui": {
        "x": 0,
        "y": 380
      },
      "enabled": true,
      "kind": "script",
      "script": "instagram/scroll-reels@latest",
      "params": {}
    },
    {
      "id": "ig-activity",
      "title": "check-activity@0.2.0",
      "ui": {
        "x": 0,
        "y": 450
      },
      "enabled": true,
      "kind": "script",
      "script": "instagram/check-activity@latest",
      "params": {}
    },
    {
      "id": "ig-inbox",
      "title": "check-inbox@0.2.0",
      "ui": {
        "x": 0,
        "y": 520
      },
      "enabled": true,
      "kind": "script",
      "script": "instagram/check-inbox@latest",
      "params": {}
    },
    {
      "id": "ig-feed",
      "title": "scroll-feed@0.3.0",
      "ui": {
        "x": 120,
        "y": 380
      },
      "enabled": true,
      "kind": "script",
      "script": "instagram/scroll-feed@latest",
      "params": {}
    },
    {
      "id": "ig-stories",
      "title": "watch-stories@0.3.0",
      "ui": {
        "x": 120,
        "y": 450
      },
      "enabled": true,
      "kind": "script",
      "script": "instagram/watch-stories@latest",
      "params": {}
    },
    {
      "id": "ig-explore",
      "title": "explore-reels@0.3.0",
      "ui": {
        "x": 120,
        "y": 520
      },
      "enabled": true,
      "kind": "script",
      "script": "instagram/explore-reels@latest",
      "params": {}
    },
    {
      "id": "ig-profile",
      "title": "check-profile@0.2.0",
      "ui": {
        "x": 0,
        "y": 590
      },
      "enabled": true,
      "kind": "script",
      "script": "instagram/check-profile@latest",
      "params": {}
    },
    {
      "id": "yt-mix",
      "title": "YouTube warm-up (random order)",
      "ui": {
        "x": 360,
        "y": 260
      },
      "enabled": true,
      "kind": "shuffle",
      "members": [
        "yt-home"
      ],
      "between": {
        "expr": "8000 + $random * 12000"
      },
      "betweenMaxMs": 20000,
      "continueOnMemberFailure": true,
      "next": "done"
    },
    {
      "id": "yt-home",
      "title": "download-home@0.19.0",
      "ui": {
        "x": 360,
        "y": 380
      },
      "enabled": true,
      "kind": "script",
      "script": "youtube/download-home@latest",
      "params": {}
    },
    {
      "id": "pick",
      "title": "Platform for this session",
      "ui": {
        "x": 0,
        "y": 120
      },
      "enabled": true,
      "kind": "switch",
      "mode": "predicate",
      "cases": [
        {
          "when": {
            "left": {
              "expr": "($device.number + $params.slot) % 3"
            },
            "op": "eq",
            "right": {
              "const": 0
            }
          },
          "to": "tt-mix",
          "label": "TikTok"
        },
        {
          "when": {
            "left": {
              "expr": "($device.number + $params.slot) % 3"
            },
            "op": "eq",
            "right": {
              "const": 1
            }
          },
          "to": "ig-mix",
          "label": "Instagram"
        },
        {
          "when": {
            "left": {
              "expr": "($device.number + $params.slot) % 3"
            },
            "op": "eq",
            "right": {
              "const": 2
            }
          },
          "to": "yt-mix",
          "label": "YouTube"
        }
      ]
    },
    {
      "id": "done",
      "title": "Done",
      "ui": {
        "x": 0,
        "y": 700
      },
      "enabled": true,
      "kind": "finish",
      "status": "succeed",
      "message": ""
    }
  ],
  "maxSteps": 50
}
