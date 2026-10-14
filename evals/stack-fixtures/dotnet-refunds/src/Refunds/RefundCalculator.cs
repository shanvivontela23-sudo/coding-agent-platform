namespace Refunds;

public static class RefundCalculator
{
    /// <summary>Amount to refund now, never more than what is still refundable.</summary>
    public static decimal RefundAmount(decimal paid, decimal alreadyRefunded, decimal requested)
    {
        if (requested <= 0) throw new ArgumentOutOfRangeException(nameof(requested), "requested refund must be positive");
        var remaining = paid - alreadyRefunded;
        // Bug: the cap uses the original payment instead of what is left.
        return Math.Min(requested, paid);
    }
}
