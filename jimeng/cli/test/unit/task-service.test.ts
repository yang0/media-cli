import { describe, expect, it } from "vitest";

import { TaskService } from "../../src/services/task-service.js";

describe("TaskService", () => {
  it("extracts image assets from history records", async () => {
    const service = new TaskService(
      {
        getHistoryByIds: async () => ({
          "task-1": {
            status: 50,
            item_list: [
              {
                image: {
                  large_images: [{ image_url: "https://example.com/image.webp" }],
                },
              },
            ],
          },
        }),
        getLocalItemList: async () => ({ item_list: [] }),
      },
      1,
      100,
    );

    const task = await service.waitForTask("task-1", "image");

    expect(task.kind).toBe("image");
    expect(task.assets[0]?.url).toBe("https://example.com/image.webp");
  });

  it("prefers upgraded local-item video URLs when available", async () => {
    const upgradedUrl = "https://example.com/video.mp4";
    const encodedUrl = Buffer.from(upgradedUrl, "utf8").toString("base64");
    const service = new TaskService(
      {
        getHistoryByIds: async () => ({
          "task-2": {
            status: 50,
            item_list: [
              {
                item_id: "item-2",
                video: {
                  play_url: "https://example.com/preview.mp4",
                },
              },
            ],
          },
        }),
        getLocalItemList: async () => ({
          item_list: [
            {
              video: {
                video_model: JSON.stringify({
                  video_list: {
                    video_1: {
                      main_url: encodedUrl,
                    },
                  },
                }),
              },
            },
          ],
        }),
      },
      1,
      100,
    );

    const task = await service.waitForTask("task-2", "video");

    expect(task.kind).toBe("video");
    expect(task.assets[0]?.url).toBe(upgradedUrl);
  });
});
