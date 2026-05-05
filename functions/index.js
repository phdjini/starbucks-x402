const functions = require("firebase-functions");
const ethers    = require("ethers");
const cors      = require("cors")({ origin: true });

// ── 설정 ──────────────────────────────────────────
const CONTRACT_ADDRESS = "0xYOUR_CONTRACT_ADDRESS"; // Remix 배포 후 교체
const ALCHEMY_URL      = "https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY";

const CONTRACT_ABI = [
  "function pay(string calldata item) external payable",
  "function getBalance() external view returns (uint256)"
];

const MENU = {
  "americano": { name: "아메리카노", price: "0.001" },
  "latte":     { name: "카페라떼",   price: "0.002" },
  "espresso":  { name: "에스프레소", price: "0.0015" }
};

// ── x402 서버 ─────────────────────────────────────
exports.order = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    const item = req.query.item;

    // 메뉴 확인
    if (!MENU[item]) {
      return res.status(404).json({ error: "메뉴 없음" });
    }

    const xPayment = req.headers["x-payment"];

    // x-payment 없음 → 402 반환
    if (!xPayment) {
      return res.status(402).json({
        item,
        name:    MENU[item].name,
        amount:  MENU[item].price,
        to:      CONTRACT_ADDRESS,
        message: `${MENU[item].name} 주문을 위해 ${MENU[item].price} ETH가 필요합니다`
      });
    }

    // x-payment 있음 → 검증 + 결제 처리
    try {
      const payload   = JSON.parse(Buffer.from(xPayment, "base64").toString());
      const { signature, message, from } = payload;

      // ① 서명 검증 (ecrecover)
      const recovered = ethers.verifyMessage(message, signature);
      if (recovered.toLowerCase() !== from.toLowerCase()) {
        return res.status(401).json({ error: "서명 검증 실패" });
      }

      // ② 잔액 확인 (eth_call)
      const provider = new ethers.JsonRpcProvider(ALCHEMY_URL);
      const balance  = await provider.getBalance(from);
      const required = ethers.parseEther(MENU[item].price);

      if (balance < required) {
        return res.status(402).json({ error: "잔액 부족" });
      }

      // ③ 트랜잭션 제출 (서버 지갑이 대신 전송)
      const serverWallet = new ethers.Wallet(
        process.env.SERVER_PRIVATE_KEY,
        provider
      );
      const contract = new ethers.Contract(
        CONTRACT_ADDRESS, CONTRACT_ABI, serverWallet
      );
      const tx = await contract.pay(item, { value: required });
      await tx.wait();

      // 200 OK
      return res.status(200).json({
        message: `${MENU[item].name} 주문 완료 ☕`,
        receipt: {
          from,
          to:     CONTRACT_ADDRESS,
          amount: MENU[item].price + " ETH",
          tx:     tx.hash,
          item
        }
      });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
});