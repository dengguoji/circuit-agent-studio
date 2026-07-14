import type { UploadedImage } from "./appTypes";

export function readImageFile(file: File): Promise<UploadedImage> {
  if (!file.type.startsWith("image/")) {
    return Promise.reject(new Error("Only image files are supported."));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
        reject(new Error("Image must be readable as a base64 data URL."));
        return;
      }

      const image = new Image();
      image.onerror = () => reject(new Error("Failed to decode image dimensions."));
      image.onload = () => {
        if (image.naturalWidth <= 10 || image.naturalHeight <= 10) {
          reject(new Error("Image width and height must both be larger than 10px."));
          return;
        }
        resolve({
          name: file.name,
          mime_type: file.type,
          data_url: dataUrl,
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
      };
      image.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}
