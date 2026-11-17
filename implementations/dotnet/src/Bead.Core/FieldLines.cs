namespace Bead;

/// <summary>
/// A request field sent in more than one field line, read as one value (spec 15.12): its lines as
/// they came, an empty one among them, joined in their order by <c>", "</c> (RFC 9110 §5.3), as
/// every side joins them.
/// </summary>
internal static class FieldLines
{
    /// <summary>
    /// The lines joined; none when the request sends none, which is not empty.
    /// </summary>
    public static string? JoinedOf(IReadOnlyList<string?> lines)
    {
        ArgumentNullException.ThrowIfNull(lines);

        // ! never StringValues.ToString(), which drops an empty line and joins the rest by ","
        return lines.Count == 0 ? null : string.Join(", ", lines.Select((line) =>
        {
            return line ?? "";
        }));
    }
}
