using System.Security.Cryptography;
using System.Text;

namespace HapsHub.Core;

/// <summary>
/// Picks and prepares the dashboard's random picture. Skips Eagle's own preview files (an Eagle library keeps a small
/// "_thumbnail" copy beside every picture), never picks the picture already shown when there's another, and shrinks
/// very large pictures (8K screenshots take about 130 MB to show) into a cached JPEG the width of a wide screen.
/// </summary>
public static class DashBackground
{
    public const int MaxWidth = 2560;
    static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase) { ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp" };

    /// <summary>True for a picture the random background may show.</summary>
    public static bool IsCandidate(string path)
    {
        if (!ImageExtensions.Contains(Path.GetExtension(path))) return false;
        var name = Path.GetFileNameWithoutExtension(path);
        // Eagle keeps "<name>_thumbnail.png" next to each picture in "<id>.info" folders.
        return !name.EndsWith("_thumbnail", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Every candidate picture under the folders, including subfolders. Folders that can't be read are skipped.</summary>
    public static List<string> Candidates(IEnumerable<string> folders)
    {
        var all = new List<string>();
        foreach (var folder in folders.Where(Directory.Exists))
        {
            try { all.AddRange(Directory.EnumerateFiles(folder, "*.*", SearchOption.AllDirectories).Where(IsCandidate)); }
            catch { /* a folder we can't read */ }
        }
        return all;
    }

    /// <summary>A random candidate other than <paramref name="current"/> when there's another. With
    /// <paramref name="landscapeOnly"/> it tries up to 60 picks for a wide one and returns null when none is found.</summary>
    public static string? Pick(IReadOnlyList<string> candidates, string? current, bool landscapeOnly, Func<string, bool>? isLandscape = null, Random? rng = null)
    {
        rng ??= Random.Shared;
        var pool = candidates.Count > 1 && !string.IsNullOrEmpty(current)
            ? candidates.Where(c => !string.Equals(c, current, StringComparison.OrdinalIgnoreCase)).ToList()
            : candidates.ToList();
        if (pool.Count == 0) return null;
        if (!landscapeOnly) return pool[rng.Next(pool.Count)];
        isLandscape ??= ImageShape.IsLandscape;
        for (int tries = 0; tries < 60; tries++)
        {
            var candidate = pool[rng.Next(pool.Count)];
            if (isLandscape(candidate)) return candidate;
        }
        return null;
    }

    /// <summary>The file to show for <paramref name="path"/>: itself when it's small enough, otherwise a JPEG at most
    /// <see cref="MaxWidth"/> wide, made once and kept in <paramref name="cacheDir"/>.</summary>
    public static string Prepared(string path, string cacheDir)
    {
        try
        {
            if (path.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".gif", StringComparison.OrdinalIgnoreCase)) return path;
            using var stream = File.OpenRead(path);
            using var codec = SkiaSharp.SKCodec.Create(stream);
            if (codec == null || codec.Info.Width <= MaxWidth) return path;
            var info = new FileInfo(path);
            var key = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes($"{info.FullName}|{info.Length}|{info.LastWriteTimeUtc.Ticks}")))[..16];
            Directory.CreateDirectory(cacheDir);
            var cached = Path.Combine(cacheDir, key + ".jpg");
            if (File.Exists(cached)) return cached;
            using var source = SkiaSharp.SKBitmap.Decode(codec);
            if (source == null) return path;
            var height = (int)Math.Round((double)source.Height * MaxWidth / source.Width);
            using var small = source.Resize(new SkiaSharp.SKImageInfo(MaxWidth, height), SkiaSharp.SKFilterQuality.High);
            if (small == null) return path;
            using var image = SkiaSharp.SKImage.FromBitmap(small);
            using var data = image.Encode(SkiaSharp.SKEncodedImageFormat.Jpeg, 88);
            if (data == null) return path;
            var temp = cached + ".tmp";
            using (var file = File.Create(temp)) data.SaveTo(file);
            File.Move(temp, cached, true);
            Trim(cacheDir, keep: 40);
            return cached;
        }
        catch { return path; }
    }

    // Keeps the newest few prepared pictures; the rest are made again if they're picked again.
    static void Trim(string cacheDir, int keep)
    {
        try
        {
            foreach (var old in new DirectoryInfo(cacheDir).GetFiles("*.jpg").OrderByDescending(f => f.LastWriteTimeUtc).Skip(keep))
                old.Delete();
        }
        catch { /* in use or gone */ }
    }
}
