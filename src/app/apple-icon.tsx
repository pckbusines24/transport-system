import { ImageResponse } from "next/og";

// iOS masks the icon with its own rounded-rect, so this fills edge to edge and
// carries no radius of its own — a rounded tile inside the mask reads as inset.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#F5C842",
        }}
      >
        <svg width="180" height="180" viewBox="0 0 180 180">
          <path
            d="M69 51 L114 90 L69 129"
            fill="none"
            stroke="#14161C"
            strokeWidth="18"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M43 70 L64 90 L43 110"
            fill="none"
            stroke="#14161C"
            strokeWidth="12"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.45"
          />
        </svg>
      </div>
    ),
    size
  );
}
