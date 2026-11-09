using System.Text;

namespace HapsHub.Core;

/// <summary>
/// Whole-file writes that leave either the old contents or the new contents on disk,
/// never a partial file, even if the process dies or the power goes mid-write.
/// Failures throw, as File.WriteAll* does, and leave the existing file untouched.
/// </summary>
public static class AtomicFile
{
    private const string TempSuffix = ".atomic-tmp";
    private static readonly int[] RetryDelaysMs = { 20, 50, 100, 200 };
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    /// <param name="backupPath">Receives the previous version of the file when one exists.</param>
    /// <param name="prepareTemp">Runs on the finished temp file before it goes live, e.g. to set permissions.</param>
    public static void WriteAllText(string path, string contents, Encoding? encoding = null,
        string? backupPath = null, Action<string>? prepareTemp = null)
    {
        var enc = encoding ?? Utf8NoBom;
        Commit(path, fs =>
        {
            fs.Write(enc.GetPreamble());
            fs.Write(enc.GetBytes(contents));
        }, backupPath, prepareTemp);
    }

    public static void WriteAllBytes(string path, byte[] contents,
        string? backupPath = null, Action<string>? prepareTemp = null)
        => Commit(path, fs => fs.Write(contents), backupPath, prepareTemp);

    public static void WriteAllLines(string path, IEnumerable<string> lines, Encoding? encoding = null,
        string? backupPath = null, Action<string>? prepareTemp = null)
    {
        var text = new StringBuilder();
        foreach (var line in lines) text.Append(line).Append(Environment.NewLine);
        WriteAllText(path, text.ToString(), encoding, backupPath, prepareTemp);
    }

    /// <summary>Removes temp files left in a folder by a process that died mid-write.</summary>
    public static int CleanOrphans(string directory, TimeSpan olderThan)
    {
        var removed = 0;
        try
        {
            if (!Directory.Exists(directory)) return 0;
            var cutoff = DateTime.UtcNow - olderThan;
            foreach (var file in Directory.EnumerateFiles(directory, "*" + TempSuffix))
            {
                try
                {
                    if (File.GetLastWriteTimeUtc(file) >= cutoff) continue;
                    File.Delete(file);
                    removed++;
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return removed;
    }

    /// <summary>Same as the public writers but with a custom body. Lets tests fail part-way through.</summary>
    internal static void Commit(string path, Action<FileStream> write, string? backupPath, Action<string>? prepareTemp)
    {
        var target = Path.GetFullPath(path);
        var directory = Path.GetDirectoryName(target)!;
        Directory.CreateDirectory(directory);

        // Same folder as the target: a rename is only atomic within one volume.
        var temp = Path.Combine(directory, $"{Path.GetFileName(target)}.{Guid.NewGuid():N}{TempSuffix}");
        try
        {
            using (var fs = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                write(fs);
                // Without this the rename can reach the disk before the data does,
                // which is how a power cut leaves an empty file behind.
                fs.Flush(flushToDisk: true);
            }
            prepareTemp?.Invoke(temp);
            MoveIntoPlace(temp, target, backupPath);
        }
        finally
        {
            try { File.Delete(temp); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static void MoveIntoPlace(string temp, string target, string? backupPath)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                if (backupPath != null && File.Exists(target))
                    File.Replace(temp, target, backupPath, ignoreMetadataErrors: true);
                else
                    File.Move(temp, target, overwrite: true);
                return;
            }
            // Antivirus and indexers briefly hold files open, which surfaces as either type.
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                       && attempt < RetryDelaysMs.Length)
            {
                Thread.Sleep(RetryDelaysMs[attempt]);
            }
        }
    }
}
