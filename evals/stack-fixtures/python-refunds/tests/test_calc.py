from decimal import Decimal

import pytest

from refunds.calc import refund_amount


def test_full_refund_of_unrefunded_payment():
    assert refund_amount(Decimal("40.00"), Decimal("0"), Decimal("40.00")) == Decimal("40.00")


def test_rejects_non_positive_request():
    with pytest.raises(ValueError):
        refund_amount(Decimal("40.00"), Decimal("0"), Decimal("0"))
