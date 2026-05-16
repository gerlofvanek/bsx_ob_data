# Allow tests to import scraper / OfferMessage / BidMessage from the parent package
# without an editable install. Keeps the test layout flat and IDE-discoverable.
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)
