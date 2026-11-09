namespace HapsHub.Core;

/// <summary>Reads an image's width and height from its header, without decoding the picture.</summary>
public static class ImageShape
{
    /// <summary>Width and height, or null when the format isn't known or the header can't be read.</summary>
    public static (int width, int height)? Read(string path)
    {
        try
        {
            using var stream = File.OpenRead(path);
            var head = new byte[64 * 1024];
            var count = stream.Read(head, 0, head.Length);
            return Read(head.AsSpan(0, count));
        }
        catch { return null; }
    }

    public static (int width, int height)? Read(ReadOnlySpan<byte> b)
    {
        if (b.Length < 26) return null;
        // PNG: IHDR right after the signature.
        if (b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G')
            return (BigEndian(b, 16), BigEndian(b, 20));
        // GIF: logical screen size.
        if (b[0] == 'G' && b[1] == 'I' && b[2] == 'F')
            return (b[6] | b[7] << 8, b[8] | b[9] << 8);
        // BMP: BITMAPINFOHEADER; height may be negative for top-down images.
        if (b[0] == 'B' && b[1] == 'M')
            return (BitConverter.ToInt32(b.Slice(18, 4)), Math.Abs(BitConverter.ToInt32(b.Slice(22, 4))));
        // WebP: lossy VP8, lossless VP8L, or extended VP8X.
        if (b.Length >= 30 && b[0] == 'R' && b[1] == 'I' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P')
        {
            var chunk = System.Text.Encoding.ASCII.GetString(b.Slice(12, 4));
            if (chunk == "VP8 ") return ((b[26] | b[27] << 8) & 0x3FFF, (b[28] | b[29] << 8) & 0x3FFF);
            if (chunk == "VP8L")
            {
                int bits = b[21] | b[22] << 8 | b[23] << 16 | b[24] << 24;
                return ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1);
            }
            if (chunk == "VP8X") return (1 + (b[24] | b[25] << 8 | b[26] << 16), 1 + (b[27] | b[28] << 8 | b[29] << 16));
            return null;
        }
        // JPEG: walk the markers to the first start-of-frame.
        if (b[0] == 0xFF && b[1] == 0xD8)
        {
            int i = 2;
            while (i + 9 < b.Length)
            {
                if (b[i] != 0xFF) { i++; continue; }
                byte marker = b[i + 1];
                if (marker == 0xD8 || marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
                int length = b[i + 2] << 8 | b[i + 3];
                bool sof = marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
                if (sof) return (b[i + 7] << 8 | b[i + 8], b[i + 5] << 8 | b[i + 6]);
                i += 2 + length;
            }
        }
        return null;
    }

    /// <summary>True only when the header says the picture is wider than it is tall.</summary>
    public static bool IsLandscape(string path) => Read(path) is { } size && size.width > size.height;

    private static int BigEndian(ReadOnlySpan<byte> b, int at) => b[at] << 24 | b[at + 1] << 16 | b[at + 2] << 8 | b[at + 3];
}
