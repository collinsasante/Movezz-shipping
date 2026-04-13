// Client-side photo upload to Cloudinary via signed upload
// 1. Get signed params from /api/upload/sign
// 2. POST directly to Cloudinary upload API
// Returns array of secure URLs

export interface UploadedPhoto {
  url: string;
  publicId: string;
  width: number;
  height: number;
}

export async function uploadPhotos(files: File[]): Promise<UploadedPhoto[]> {
  if (files.length === 0) return [];

  // Get signed params from our server
  const signRes = await fetch("/api/upload/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder: "movezz/items" }),
  });

  if (!signRes.ok) throw new Error("Failed to get upload signature");

  const { data: signData } = await signRes.json();
  const { signature, timestamp, cloudName, apiKey, folder } = signData;

  // Upload all files in parallel
  const uploads = files.map(async (file) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("api_key", apiKey);
    formData.append("timestamp", String(timestamp));
    formData.append("signature", signature);
    formData.append("folder", folder);

    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      { method: "POST", body: formData }
    );

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? "Upload failed");
    }

    const data = await res.json();
    return {
      url: data.secure_url as string,
      publicId: data.public_id as string,
      width: data.width as number,
      height: data.height as number,
    };
  });

  return Promise.all(uploads);
}
