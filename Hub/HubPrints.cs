using System.Text.RegularExpressions;

namespace HapsHub.Core;

/// <summary>
/// Finds VRChat prints (issue 11). VRChat saves a print as a 2048x1440 PNG named like a normal photo: the photo inside
/// a white frame with a footer ("Captured By", date, world, host). The normal photo is saved too, so prints are copies.
/// Both the size in the name and the white frame must match before a file counts as a print.
/// </summary>
public static class HubPrints
{
    private static readonly Regex PrintName = new(@"^VRChat_.+_2048x1440(_wrld_[0-9a-f-]+)?\.png$", RegexOptions.IgnoreCase);

    // Frame corners, the sides, and the white strip between the photo and the footer text.
    private static readonly (int X, int Y)[] FramePoints =
        { (12, 12), (1024, 12), (2035, 12), (12, 720), (2035, 720), (12, 1428), (2035, 1428), (1024, 1300) };

    public static bool NameLooksLikePrint(string path) => PrintName.IsMatch(Path.GetFileName(path));

    public static bool IsPrint(string path)
    {
        if (!NameLooksLikePrint(path)) return false;
        try
        {
            using var bmp = SkiaSharp.SKBitmap.Decode(path);
            if (bmp == null || bmp.Width != 2048 || bmp.Height != 1440) return false;
            foreach (var (x, y) in FramePoints)
            {
                var c = bmp.GetPixel(x, y);
                if (c.Red < 235 || c.Green < 235 || c.Blue < 235) return false;
            }
            return true;
        }
        catch { return false; }
    }

    public static List<string> Find(IEnumerable<string> folders)
    {
        var found = new List<string>();
        foreach (var folder in folders)
        {
            if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) continue;
            IEnumerable<string> files;
            try { files = Directory.EnumerateFiles(folder, "VRChat_*_2048x1440*.png", new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true }); }
            catch { continue; }
            foreach (var f in files)
                if (IsPrint(f)) found.Add(f);
        }
        return found.Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(f => f, StringComparer.OrdinalIgnoreCase).ToList();
    }
}
