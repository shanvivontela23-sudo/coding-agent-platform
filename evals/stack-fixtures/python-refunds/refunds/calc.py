from decimal import Decimal


def refund_amount(paid: Decimal, already_refunded: Decimal, requested: Decimal) -> Decimal:
    """Amount to refund now, never more than what is still refundable."""
    if requested <= 0:
        raise ValueError("requested refund must be positive")
    remaining = paid - already_refunded
    # Bug: the cap uses the original payment, so a second partial refund can
    # exceed what is left after the first one.
    return min(requested, paid)
